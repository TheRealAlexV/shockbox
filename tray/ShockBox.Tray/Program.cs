using System.Diagnostics;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Text.Json;
using System.Threading;
using System.Windows.Forms;

namespace ShockBox.Tray;

internal static class Program
{
    // One tray per machine. Global\ needs no elevation for a mutex; if a restricted token refuses
    // it, the Local\ fallback still gives one tray per desktop instead of two icons.
    private const string GlobalMutexName = @"Global\ShockBox.Tray";
    private const string SessionMutexName = @"Local\ShockBox.Tray";
    private const string WakeEventName = @"Global\ShockBox.Tray.Wake";

    private const long SignalMagic = 0x53484F434B424F58;

    private const string Usage =
        "usage: ShockBox.Tray.exe [--send start|stop|restart|shutdown] [--status] [--menu]";

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool AttachConsole(int processId);

    /// <summary>
    /// The menu, made testable without the icon: --send calls the same Supervisor.Send the tray's
    /// RunAction calls, and --status reads the same files the watchdog reads. Neither creates a
    /// tray icon, a window or a message sink, and neither touches the latch.
    /// </summary>
    private static int RunCli(string[] args)
    {
        // WinExe: a console caller otherwise sees nothing at all. Skip the attach when the caller
        // redirected stdout, because AttachConsole rebinds the standard handles and the output
        // would land in the console instead of the caller's file.
        if (!Console.IsOutputRedirected)
        {
            AttachConsole(-1);
        }

        var supervisor = new Supervisor();

        if (args.Length == 1 && args[0] == "--status")
        {
            return PrintStatus(supervisor);
        }

        if (args.Length == 1 && args[0] == "--menu")
        {
            return PrintMenu();
        }

        if (args.Length == 1 && args[0] == "--menu-show")
        {
            return RunMenuShow(supervisor);
        }

        if (args.Length == 2 && args[0] == "--send")
        {
            try
            {
                string json = supervisor.Send(args[1]);
                Console.WriteLine(json);
                Console.WriteLine(AppPaths.CmdFile);
                return 0;
            }
            catch (ArgumentException)
            {
                Console.Error.WriteLine(Usage);
                return 2;
            }
            catch (Exception ex)
            {
                Console.Error.WriteLine(ex.GetType().FullName + ": " + ex.Message);
                return 1;
            }
        }

        Console.Error.WriteLine(Usage);
        return 2;
    }

    /// <summary>
    /// Prints the menu the tray would show, using TrayContext's own builder, without creating an
    /// icon, a window or a menu. This is the wiring, not a transcription of it.
    /// </summary>
    /// <summary>
    /// Shows the tray's real menu as a real window without the shell: same BuildMenuItems output,
    /// same handlers, no NotifyIcon. Exists so the menu can be inspected and clicked by a tester.
    /// </summary>
    private static int RunMenuShow(Supervisor supervisor)
    {
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);

        MainForm? window = null;
        var menu = new ContextMenuStrip();

        foreach (ToolStripItem item in TrayContext.BuildMenuItems(
            StatusSummary(),
            verb => SendQuietly(supervisor, verb),
            () => SendQuietly(supervisor, "shutdown"),
            () =>
            {
                window ??= new MainForm(AppPaths.BaseUrl);
                window.Show();
                window.Activate();
            },
            () => OpenWithShell(AppPaths.BaseUrl),
            () => OpenWithShell(AppPaths.RuntimeDir),
            menu.Close))
        {
            menu.Items.Add(item);
        }

        Rectangle area = Screen.PrimaryScreen!.WorkingArea;
        Size size = menu.GetPreferredSize(Size.Empty);
        menu.Show(new Point(area.Right - size.Width - 120, area.Bottom - size.Height - 90));

        DateTime deadline = DateTime.UtcNow.AddSeconds(60);
        while (DateTime.UtcNow < deadline && menu.Visible)
        {
            Application.DoEvents();
            Thread.Sleep(50);
        }
        menu.Dispose();

        // A click on "Open window" would otherwise vanish with the menu: hold it long enough to see.
        if (window is not null)
        {
            DateTime hold = DateTime.UtcNow.AddSeconds(12);
            while (DateTime.UtcNow < hold && !window.IsDisposed)
            {
                Application.DoEvents();
                Thread.Sleep(50);
            }
            if (!window.IsDisposed)
            {
                window.Dispose();
            }
        }
        return 0;
    }

    private static void SendQuietly(Supervisor supervisor, string verb)
    {
        try
        {
            supervisor.Send(verb);
        }
        catch (Exception ex) when (ex is IOException || ex is ArgumentException)
        {
            Console.Error.WriteLine(ex.Message);
        }
    }

    private static void OpenWithShell(string target)
    {
        try
        {
            Process.Start(new ProcessStartInfo(target) { UseShellExecute = true });
        }
        catch (Exception ex) when (ex is System.ComponentModel.Win32Exception || ex is IOException)
        {
            Console.Error.WriteLine(ex.Message);
        }
    }

    private static string StatusSummary()
    {
        try
        {
            using JsonDocument document = JsonDocument.Parse(File.ReadAllText(AppPaths.StatusFile));
            string state = document.RootElement.TryGetProperty("state", out JsonElement stateElement) ? stateElement.ToString() : "unknown";
            string node = document.RootElement.TryGetProperty("node_pid", out JsonElement nodeElement) ? nodeElement.ToString() : "?";
            return "ShockBox " + state + " \u00b7 node " + node;
        }
        catch (Exception ex) when (ex is IOException || ex is JsonException || ex is UnauthorizedAccessException)
        {
            return "ShockBox unknown";
        }
    }

    private static int PrintMenu()
    {
        int index = 0;
        List<ToolStripItem> items = TrayContext.BuildMenuItems(
            "(status line, generated when the menu opens)",
            _ => { },
            () => { },
            () => { },
            () => { },
            () => { },
            () => { });

        foreach (ToolStripItem item in items)
        {
            if (item is ToolStripSeparator)
            {
                Console.WriteLine("---");
            }
            else
            {
                index++;
                Console.WriteLine(string.Format(CultureInfo.InvariantCulture, "{0}. {1} | enabled={2}", index, item.Text, item.Enabled));
            }
            item.Dispose();
        }
        return 0;
    }

    private static int PrintStatus(Supervisor supervisor)
    {
        int? pid = supervisor.SupervisorPid;
        bool alive = pid is int live && Interop.ProcessAlive(live);
        TimeSpan? age = supervisor.HeartbeatAge;

        string state = "(no status.json)";
        string node = "(unknown)";
        try
        {
            using JsonDocument document = JsonDocument.Parse(File.ReadAllText(AppPaths.StatusFile));
            if (document.RootElement.TryGetProperty("state", out JsonElement stateElement))
            {
                state = stateElement.ToString();
            }
            if (document.RootElement.TryGetProperty("node_pid", out JsonElement nodeElement))
            {
                node = nodeElement.ToString();
            }
        }
        catch (Exception ex) when (ex is IOException || ex is JsonException || ex is UnauthorizedAccessException)
        {
            state = "(unreadable: " + ex.GetType().Name + ")";
        }

        bool health = false;
        try
        {
            using var http = new HttpClient { Timeout = TimeSpan.FromSeconds(5) };
            using HttpResponseMessage response = http.GetAsync(new Uri(AppPaths.BaseUrl + "health")).GetAwaiter().GetResult();
            health = response.IsSuccessStatusCode;
        }
        catch (Exception ex) when (ex is HttpRequestException || ex is OperationCanceledException)
        {
        }

        Console.WriteLine("supervisor pid " + (pid.HasValue ? pid.GetValueOrDefault().ToString(CultureInfo.InvariantCulture) : "(none)") + " alive " + alive);
        Console.WriteLine("heartbeat age " + (age is TimeSpan span ? span.TotalSeconds.ToString("0.0", CultureInfo.InvariantCulture) : "(none)") + " s");
        Console.WriteLine("status.json state " + state);
        Console.WriteLine("node pid " + node);
        Console.WriteLine("health " + AppPaths.BaseUrl + "health ok " + health);
        return alive && health ? 0 : 1;
    }

    [STAThread]
    private static int Main(string[] args)
    {
        if (args.Length > 0)
        {
            return RunCli(args);
        }
        // The manifest declares PerMonitorV2 as well; setting it here keeps the tray menu crisp
        // even when the manifest is bypassed (a debug host, for instance).
        Application.SetHighDpiMode(HighDpiMode.PerMonitorV2);
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);

        // This is a WinExe: an unhandled exception would otherwise vanish with no console to
        // print it. Both hooks write to tray.log so the next failure has a paper trail.
        Application.SetUnhandledExceptionMode(UnhandledExceptionMode.CatchException);
        Application.ThreadException += (_, e) =>
            TrayLog.Write("unhandled ui: " + e.Exception.GetType().Name + ": " + e.Exception.Message);
        AppDomain.CurrentDomain.UnhandledException += (_, e) =>
        {
            if (e.ExceptionObject is Exception exception)
            {
                TrayLog.Write("unhandled: " + exception.GetType().Name + ": " + exception.Message);
            }
        };

        Mutex? guard = AcquireGuard(out bool isFirst);
        if (!isFirst)
        {
            // A second launch is a request to show the window, not a second tray icon.
            SignalFirstInstance();
            guard?.Dispose();
            return 0;
        }

        EventWaitHandle? wake = CreateWakeEvent();
        using (var context = new TrayContext(wake))
        {
            Application.Run(context);
        }

        wake?.Dispose();
        GC.KeepAlive(guard);
        if (guard is not null)
        {
            guard.ReleaseMutex();
            guard.Dispose();
        }
        return 0;
    }

    private static Mutex? AcquireGuard(out bool isFirst)
    {
        isFirst = false;
        try
        {
            var guard = new Mutex(true, GlobalMutexName, out isFirst);
            if (isFirst) return guard;
            guard.Dispose();
            return null;
        }
        catch (UnauthorizedAccessException)
        {
            try
            {
                var guard = new Mutex(true, SessionMutexName, out isFirst);
                if (isFirst) return guard;
                guard.Dispose();
                return null;
            }
            catch (UnauthorizedAccessException)
            {
                // Cannot guard at all: running unguarded beats refusing to start.
                isFirst = true;
                return null;
            }
        }
    }

    private static void SignalFirstInstance()
    {
        IntPtr target = Interop.FindWindow(null, TrayMessageWindow.WindowTitle);
        if (target != IntPtr.Zero)
        {
            var payload = new Interop.CopyDataStruct
            {
                dwData = new IntPtr(SignalMagic),
                cbData = 0,
                lpData = IntPtr.Zero,
            };
            Interop.SendMessage(target, TrayMessageWindow.WmCopyData, IntPtr.Zero, ref payload);
        }

        // The window is created at startup, so the WM_COPYDATA above normally lands. The event is
        // the second, independent path in case it does not (a slow first start, a refused message
        // across integrity levels): the first instance waits on it and shows itself either way.
        try
        {
            using EventWaitHandle wake = EventWaitHandle.OpenExisting(WakeEventName);
            wake.Set();
        }
        catch (WaitHandleCannotBeOpenedException)
        {
        }
        catch (UnauthorizedAccessException)
        {
        }
    }

    private static EventWaitHandle? CreateWakeEvent()
    {
        try
        {
            return new EventWaitHandle(false, EventResetMode.AutoReset, WakeEventName);
        }
        catch (UnauthorizedAccessException)
        {
            return null;
        }
        catch (IOException)
        {
            return null;
        }
    }
}
