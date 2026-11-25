using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Globalization;
using System.Text;
using System.Threading;
using System.Windows.Forms;

namespace ShockBox.Tray;

internal enum TrayState
{
    Running,
    Starting,
    Backoff,
    Stopped,
    Failed,
    NoSupervisor,
    Stale,
}

/// <summary>
/// The tray itself: one icon, one dynamic menu, one watchdog. Everything that is HTTP (the page,
/// the module list) belongs to the browser; this class only decides what the four local duties
/// should do, and how their state reads.
/// </summary>
internal sealed class TrayContext : ApplicationContext
{
    /// <summary>app.py:WATCHDOG_INTERVAL_S — also the rate limit for a respawn attempt.</summary>
    private const double WatchdogIntervalSeconds = 10.0;

    private readonly Supervisor _supervisor = new Supervisor();
    private readonly StatusPoller _poller;
    private readonly NotifyIcon _icon;
    private readonly ContextMenuStrip _menu = new ContextMenuStrip();
    private readonly TrayMessageWindow _sink;
    private readonly System.Threading.Timer _watchdog;
    private readonly EventWaitHandle? _wake;
    private readonly RegisteredWaitHandle? _wakeRegistration;

    private MainForm? _window;
    private StatusSnapshot _snapshot = new StatusSnapshot();
    private TrayState _state = TrayState.NoSupervisor;
    private int _watchdogBusy;
    private bool _disposed;

    /// <summary>
    /// "The user asked for it to be gone." Only shutdown sets it; start and restart clear it.
    /// Stop deliberately leaves it alone — see RunAction for why that must stay true.
    /// </summary>
    private volatile bool _latched;

    public TrayContext(EventWaitHandle? wake)
    {
        _wake = wake;

        _sink = new TrayMessageWindow();
        _sink.ShowRequested += (_, _) => ShowWindow();
        _sink.TaskbarRecreated += (_, _) => RestoreIcon();

        _icon = new NotifyIcon
        {
            Icon = TrayIcons.For(TrayState.NoSupervisor),
            Text = "ShockBox: starting",
            ContextMenuStrip = _menu,
            Visible = true,
        };
        _icon.MouseClick += OnIconMouseClick;

        _menu.Opening += (_, _) => BuildMenu();

        _poller = new StatusPoller(_supervisor);
        _poller.Updated += OnSnapshotUpdated;

        _watchdog = new System.Threading.Timer(
            _ => OnWatchdogTick(),
            null,
            TimeSpan.FromSeconds(WatchdogIntervalSeconds),
            TimeSpan.FromSeconds(WatchdogIntervalSeconds));

        if (wake is not null)
        {
            _wakeRegistration = ThreadPool.RegisterWaitForSingleObject(wake, OnWake, null, Timeout.Infinite, false);
        }

        TrayLog.Write(string.Format(
            CultureInfo.InvariantCulture,
            "start: tray pid {0}, port {1}, app dir {2}, runtime dir {3}",
            Environment.ProcessId,
            AppPaths.Port,
            AppPaths.AppDir,
            AppPaths.RuntimeDir));
    }

    // ---- actions ---------------------------------------------------------------------------

    private void RunAction(string verb)
    {
        switch (verb)
        {
            case "start":
            case "restart":
                _latched = false;
                break;

            case "shutdown":
                _latched = true;
                break;

            case "stop":
                // Stop deliberately does NOT set the latch, and that asymmetry is the contract:
                // stop asks the supervisor to stop *node*, while the supervisor keeps running and
                // keeps writing heartbeats, so the watchdog already has nothing to do. Latching
                // here would also mute the watchdog against a supervisor that crashes later, and
                // the tray would then sit there reporting a problem it had decided not to fix.
                break;
        }

        Task.Run(() =>
        {
            try
            {
                // control.py:start()/restart() both ensure a supervisor first; the command is the
                // second half of the action, not the whole of it.
                if (verb is "start" or "restart")
                {
                    _supervisor.EnsureSupervisor();
                }
                _supervisor.Send(verb);
            }
            catch (Exception ex)
            {
                TrayLog.Write(verb + ": failed: " + ex.GetType().Name + ": " + ex.Message);
            }
        });
    }

    private void ConfirmShutdown()
    {
        DialogResult answer = MessageBox.Show(
            "Shut down the ShockBox supervisor and its node process?",
            "ShockBox",
            MessageBoxButtons.YesNo,
            MessageBoxIcon.Question,
            MessageBoxDefaultButton.Button2);
        if (answer == DialogResult.Yes) RunAction("shutdown");
    }

    private void ToggleWindow()
    {
        if (_window is { Visible: true })
        {
            _window.Hide();
            return;
        }
        ShowWindow();
    }

    private void ShowWindow()
    {
        if (_window is null || _window.IsDisposed)
        {
            _window = new MainForm(AppPaths.BaseUrl);
        }
        _window.Show();
        if (_window.WindowState == FormWindowState.Minimized) _window.WindowState = FormWindowState.Normal;
        _window.Activate();
        _window.BringToFront();
        Interop.SetForegroundWindow(_window.Handle);
    }

    private void OpenInBrowser()
    {
        try
        {
            Process.Start(new ProcessStartInfo(AppPaths.BaseUrl) { UseShellExecute = true });
        }
        catch (Exception ex) when (ex is System.ComponentModel.Win32Exception || ex is InvalidOperationException)
        {
            TrayLog.Write("browser: cannot open " + AppPaths.BaseUrl + ": " + ex.Message);
        }
    }

    private void OpenLogFolder()
    {
        try
        {
            Directory.CreateDirectory(AppPaths.RuntimeDir);
            Process.Start(new ProcessStartInfo
            {
                FileName = "explorer.exe",
                Arguments = "\"" + AppPaths.RuntimeDir + "\"",
                UseShellExecute = true,
            });
        }
        catch (Exception ex) when (ex is System.ComponentModel.Win32Exception || ex is IOException || ex is UnauthorizedAccessException)
        {
            TrayLog.Write("logs: cannot open " + AppPaths.RuntimeDir + ": " + ex.Message);
        }
    }

    private void Quit()
    {
        if (_disposed) return;
        _disposed = true;
        TrayLog.Write("quit: tray closing, supervisor left running");
        _watchdog.Dispose();
        _poller.Dispose();
        _wakeRegistration?.Unregister(null);
        _wake?.Dispose();
        _icon.Visible = false;
        _sink.Dispose();
        _window?.Dispose();
        _icon.Dispose();
        _menu.Dispose();
        ExitThread();
    }

    // ---- watchdog --------------------------------------------------------------------------

    private void OnWatchdogTick()
    {
        if (_disposed) return;
        if (Interlocked.Exchange(ref _watchdogBusy, 1) == 1) return;
        try
        {
            if (_latched) return;
            if (_supervisor.IsAlive) return;

            TimeSpan? age = _supervisor.HeartbeatAge;
            int? pid = _supervisor.SupervisorPid;
            bool processGone = pid is not int live || !Interop.ProcessAlive(live);
            bool heartbeatStale = age is TimeSpan span && span.TotalSeconds > Supervisor.HeartbeatStaleSeconds;

            // A dead pid is proof on its own (nothing else can be writing that heartbeat). A
            // live pid with a heartbeat still inside the 12 s window is a supervisor that is
            // merely lagging: spawning through that window is exactly how a second supervisor
            // gets started, so wait it out.
            if (!processGone && !heartbeatStale) return;

            TrayLog.Write(age is TimeSpan stale
                ? string.Format(
                    CultureInfo.InvariantCulture,
                    "watchdog: supervisor absent or heartbeat stale (age {0:0.0}s), starting",
                    stale.TotalSeconds)
                : "watchdog: supervisor absent, starting");

            // ensure_supervisor is idempotent and already refuses a fresh heartbeat; this gate
            // bounds the call rate and skips a tick while a spawn is still proving itself.
            _supervisor.EnsureSupervisor(skipIfBusy: true);
        }
        catch (Exception ex)
        {
            TrayLog.Write("watchdog: " + ex.GetType().Name + ": " + ex.Message);
        }
        finally
        {
            Interlocked.Exchange(ref _watchdogBusy, 0);
        }
    }

    private void OnWake(object? state, bool timedOut)
    {
        if (_disposed) return;
        try
        {
            _sink.BeginInvoke(new Action(ShowWindow));
        }
        catch (InvalidOperationException)
        {
        }
        catch (ObjectDisposedException)
        {
        }
    }

    private void RestoreIcon()
    {
        // Windows does not put tray icons back when explorer restarts; re-adding is the only fix.
        _icon.Visible = false;
        ApplySnapshot(_poller.Snapshot);
        _icon.Visible = true;
        TrayLog.Write("tray: explorer restarted, icon re-added");
    }

    // ---- rendering -------------------------------------------------------------------------

    private void OnSnapshotUpdated(object? sender, StatusSnapshot snapshot)
    {
        if (_disposed) return;
        TrayMessageWindow sink = _sink;
        if (!sink.IsHandleCreated) return;
        try
        {
            sink.BeginInvoke(new Action(ApplyLatest));
        }
        catch (InvalidOperationException)
        {
        }
        catch (ObjectDisposedException)
        {
        }
    }

    private void ApplyLatest()
    {
        ApplySnapshot(_poller.Snapshot);
    }

    private void ApplySnapshot(StatusSnapshot snapshot)
    {
        _snapshot = snapshot;
        _state = DeriveState(snapshot);
        _icon.Icon = TrayIcons.For(_state);
        _icon.Text = Tooltip(snapshot, _state);
    }

    private TrayState DeriveState(StatusSnapshot snapshot)
    {
        if (_latched) return TrayState.Stopped;
        if (snapshot.HeartbeatAgeSeconds is not null && !snapshot.SupervisorAlive) return TrayState.Stale;
        if (!snapshot.SupervisorAlive) return TrayState.NoSupervisor;

        return snapshot.State switch
        {
            "running" => TrayState.Running,
            "starting" => TrayState.Starting,
            "backoff" => TrayState.Backoff,
            "stopped" => TrayState.Stopped,
            "failed" => TrayState.Failed,
            _ => snapshot.HealthOk ? TrayState.Running : TrayState.Stale,
        };
    }

    private void BuildMenu()
    {
        _menu.Items.Clear();
        _menu.Items.Add(new ToolStripMenuItem(StatusLine()) { Enabled = false });
        _menu.Items.Add(new ToolStripSeparator());
        _menu.Items.Add(MenuItem("Start", () => RunAction("start")));
        _menu.Items.Add(MenuItem("Stop", () => RunAction("stop")));
        _menu.Items.Add(MenuItem("Restart", () => RunAction("restart")));
        _menu.Items.Add(MenuItem("Shut down\u2026", ConfirmShutdown));
        _menu.Items.Add(new ToolStripSeparator());
        _menu.Items.Add(MenuItem("Open window", ShowWindow));
        _menu.Items.Add(MenuItem("Open in browser", OpenInBrowser));
        _menu.Items.Add(MenuItem("Open log folder", OpenLogFolder));
        _menu.Items.Add(new ToolStripSeparator());
        _menu.Items.Add(MenuItem("Quit", Quit));
    }

    private static ToolStripMenuItem MenuItem(string text, Action action)
    {
        var item = new ToolStripMenuItem(text);
        item.Click += (_, _) => action();
        return item;
    }

    private string StatusLine()
    {
        StatusSnapshot snapshot = _snapshot;
        var builder = new StringBuilder("ShockBox ");
        builder.Append(Word(_state));
        if (snapshot.NodePid is int nodePid)
        {
            builder.Append(" \u00b7 node ").Append(nodePid.ToString(CultureInfo.InvariantCulture));
        }
        if (snapshot.UptimeSeconds is int uptime)
        {
            builder.Append(" \u00b7 up ").Append(FormatUptime(uptime));
        }
        if (snapshot.Restarts is int restarts)
        {
            builder.Append(" \u00b7 ").Append(restarts.ToString(CultureInfo.InvariantCulture)).Append(" restarts");
        }
        if (snapshot.ModulesDown.Count > 0)
        {
            builder.Append(" \u00b7 down: ").Append(string.Join(", ", snapshot.ModulesDown));
        }
        return builder.ToString();
    }

    private static string Tooltip(StatusSnapshot snapshot, TrayState state)
    {
        var builder = new StringBuilder("ShockBox: ");
        builder.Append(Word(state));
        if (snapshot.NodePid is int nodePid)
        {
            builder.Append(", node ").Append(nodePid.ToString(CultureInfo.InvariantCulture));
        }
        if (snapshot.UptimeSeconds is int uptime)
        {
            builder.Append(", up ").Append(FormatUptime(uptime));
        }
        if (snapshot.Restarts is int restarts)
        {
            builder.Append(", ").Append(restarts.ToString(CultureInfo.InvariantCulture));
            builder.Append(restarts == 1 ? " restart" : " restarts");
        }
        if (!string.IsNullOrWhiteSpace(snapshot.LastError))
        {
            builder.Append(", error: ").Append(snapshot.LastError);
        }

        string text = builder.ToString().Replace("\r", " ", StringComparison.Ordinal).Replace("\n", " ", StringComparison.Ordinal);
        // NotifyIcon.Text is capped (127 chars in modern .NET); stay below it rather than throw.
        return text.Length <= 120 ? text : text.Substring(0, 117) + "...";
    }

    private static string Word(TrayState state)
    {
        return state switch
        {
            TrayState.Running => "running",
            TrayState.Starting => "starting",
            TrayState.Backoff => "backoff",
            TrayState.Stopped => "stopped",
            TrayState.Failed => "failed",
            TrayState.Stale => "stale",
            _ => "no supervisor",
        };
    }

    private static string FormatUptime(int seconds)
    {
        TimeSpan span = TimeSpan.FromSeconds(seconds);
        if (span.TotalHours >= 1)
        {
            return ((int)span.TotalHours).ToString(CultureInfo.InvariantCulture)
                + "h" + span.Minutes.ToString("00", CultureInfo.InvariantCulture) + "m";
        }
        if (span.TotalMinutes >= 1)
        {
            return span.Minutes.ToString(CultureInfo.InvariantCulture)
                + "m" + span.Seconds.ToString("00", CultureInfo.InvariantCulture) + "s";
        }
        return span.Seconds.ToString(CultureInfo.InvariantCulture) + "s";
    }
}

/// <summary>
/// State is carried by colour as well as the tooltip text and the menu line, so a glance works
/// without reading: green running, amber starting/backoff, grey stopped, orange stale, red
/// failed, dark grey absent. Icons are drawn once and kept for the life of the process.
/// </summary>
internal static class TrayIcons
{
    private static readonly Dictionary<TrayState, Icon> Cache = new Dictionary<TrayState, Icon>();
    private static readonly object Gate = new object();

    public static Icon For(TrayState state)
    {
        lock (Gate)
        {
            if (!Cache.TryGetValue(state, out Icon? icon))
            {
                icon = Create(ColorFor(state));
                Cache[state] = icon;
            }
            return icon;
        }
    }

    private static Color ColorFor(TrayState state)
    {
        return state switch
        {
            TrayState.Running => Color.FromArgb(46, 160, 67),
            TrayState.Starting => Color.FromArgb(210, 153, 34),
            TrayState.Backoff => Color.FromArgb(210, 153, 34),
            TrayState.Stopped => Color.FromArgb(110, 118, 129),
            TrayState.Stale => Color.FromArgb(219, 109, 40),
            TrayState.Failed => Color.FromArgb(218, 54, 51),
            _ => Color.FromArgb(60, 66, 74),
        };
    }

    private static Icon Create(Color color)
    {
        using var bitmap = new Bitmap(16, 16);
        using (Graphics graphics = Graphics.FromImage(bitmap))
        {
            graphics.SmoothingMode = SmoothingMode.AntiAlias;
            graphics.Clear(Color.Transparent);
            using var fill = new SolidBrush(color);
            graphics.FillEllipse(fill, 1f, 1f, 14f, 14f);
            using var edge = new Pen(Color.FromArgb(70, 0, 0, 0), 1f);
            graphics.DrawEllipse(edge, 1f, 1f, 14f, 14f);
        }

        IntPtr handle = bitmap.GetHicon();
        try
        {
            using Icon sourced = Icon.FromHandle(handle);
            return (Icon)sourced.Clone();
        }
        finally
        {
            Interop.DestroyIcon(handle);
        }
    }
}
