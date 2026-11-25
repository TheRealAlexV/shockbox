using System.Globalization;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;
using System.Threading;

namespace ShockBox.Tray;

/// <summary>
/// The two trees the supervisor contract cares about, resolved the way
/// tools/tui/shockbox_tui/paths.py resolves them: the install dir (server.mjs, config.json) and
/// the machine-wide runtime dir. The runtime dir is deliberately not per-account — a per-user
/// split is what once let two supervisors each see an empty runtime dir.
/// </summary>
internal static class AppPaths
{
    public const int DefaultPort = 8972;

    private static readonly Lazy<int> CachedPort = new(ReadPort, LazyThreadSafetyMode.ExecutionAndPublication);

    public static string AppDir { get; } = ResolveAppDir();

    public static string RuntimeDir { get; } = ResolveRuntimeDir();

    public static string PythonExe => Path.Combine(AppDir, ".tui-venv", "Scripts", "python.exe");

    public static string StatusFile => Path.Combine(RuntimeDir, "status.json");

    /// <summary>
    /// Rewritten every heartbeat (about 2 s) with "&lt;counter&gt; &lt;ISO8601 UTC&gt;\n", so its
    /// mtime is the freshness signal: status.json only changes when something changes and
    /// therefore cannot say whether the writer is still there.
    /// </summary>
    public static string HeartbeatFile => Path.Combine(RuntimeDir, "heartbeat");

    public static string SupervisorPidFile => Path.Combine(RuntimeDir, "supervisor.pid");

    public static string SupervisorLockFile => Path.Combine(RuntimeDir, "supervisor.lock");

    public static string CmdFile => Path.Combine(RuntimeDir, "cmd.json");

    public static string SupervisorLog => Path.Combine(RuntimeDir, "supervisor.log");

    public static int Port => CachedPort.Value;

    public static string BaseUrl => "http://127.0.0.1:" + Port.ToString(CultureInfo.InvariantCulture) + "/";

    private static string ResolveAppDir()
    {
        string? fromEnvironment = Environment.GetEnvironmentVariable("SHOCKBOX_APP_DIR");
        if (!string.IsNullOrWhiteSpace(fromEnvironment)) return fromEnvironment;
        return @"C:\OBS\ShockBox";
    }

    private static string ResolveRuntimeDir()
    {
        string? fromEnvironment = Environment.GetEnvironmentVariable("SHOCKBOX_RUNTIME_DIR");
        if (!string.IsNullOrWhiteSpace(fromEnvironment)) return fromEnvironment;
        string programData = Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData);
        return Path.Combine(programData, "ShockBox", "runtime");
    }

    private static int ReadPort()
    {
        // config.json is the one place the port is declared; a missing or broken file means the
        // documented default, exactly as settings.py:port_of decides it.
        try
        {
            string config = Path.Combine(AppDir, "config.json");
            if (File.Exists(config))
            {
                using JsonDocument document = JsonDocument.Parse(File.ReadAllText(config));
                if (document.RootElement.ValueKind == JsonValueKind.Object
                    && document.RootElement.TryGetProperty("port", out JsonElement port))
                {
                    if (port.ValueKind == JsonValueKind.Number && port.TryGetInt32(out int number) && number > 0)
                    {
                        return number;
                    }
                    if (port.ValueKind == JsonValueKind.String
                        && int.TryParse(port.GetString(), NumberStyles.Integer, CultureInfo.InvariantCulture, out int parsed)
                        && parsed > 0)
                    {
                        return parsed;
                    }
                }
            }
        }
        catch (IOException)
        {
        }
        catch (UnauthorizedAccessException)
        {
        }
        catch (JsonException)
        {
        }
        return DefaultPort;
    }
}

/// <summary>
/// The four duties that are genuinely local to this machine, ported from
/// tools/tui/shockbox_tui/control.py:
///   * proof of life is a live pid AND a heartbeat fresher than 12 s — never a pid file alone;
///   * spawn is the venv interpreter, detached, with stdout on supervisor.log;
///   * a command is an atomically written cmd.json naming one of four verbs;
///   * nothing is ever killed, and nothing is ever matched by name or command line.
/// </summary>
internal sealed class Supervisor
{
    /// <summary>Six heartbeat intervals of silence: HEARTBEAT_STALE_S in paths.py.</summary>
    public const double HeartbeatStaleSeconds = 12.0;

    private const double ActionTimeoutSeconds = 20.0;
    private const int SpawnPollMilliseconds = 250;

    // Two callers (a menu click and the watchdog) racing here would both spawn. The supervisor's
    // own OS lock would still pick one winner, but not spawning twice is cheaper than relying on
    // that: this gate makes the decision single-flight inside the tray.
    private static readonly SemaphoreSlim EnsureGate = new(1, 1);

    /// <summary>The pid CreateProcess handed back. Tracked so a log line can name it; never killed.</summary>
    public int? LastSpawnPid { get; private set; }

    /// <summary>
    /// Published pid, verified, or the pid status.json reports. No command line is inspected: a
    /// pyvenv launcher stub and the real interpreter are identical there, and a SYSTEM-owned
    /// supervisor must be adopted exactly like one owned by this account.
    /// </summary>
    public int? SupervisorPid => ReadPublishedPid() ?? ReadStatusPid();

    /// <summary>Age of the heartbeat file, or null when there is no heartbeat at all.</summary>
    public TimeSpan? HeartbeatAge
    {
        get
        {
            try
            {
                if (!File.Exists(AppPaths.HeartbeatFile)) return null;
                return DateTime.UtcNow - File.GetLastWriteTimeUtc(AppPaths.HeartbeatFile);
            }
            catch (IOException)
            {
                return null;
            }
            catch (UnauthorizedAccessException)
            {
                return null;
            }
        }
    }

    /// <summary>Alive means a live pid and a fresh heartbeat. Either one alone lies.</summary>
    public bool IsAlive
    {
        get
        {
            int? pid = SupervisorPid;
            TimeSpan? age = HeartbeatAge;
            return pid is int live
                && Interop.ProcessAlive(live)
                && age is TimeSpan fresh
                && fresh.TotalSeconds <= HeartbeatStaleSeconds;
        }
    }

    /// <summary>
    /// Start the supervisor unless one is provably alive; true when it is (now) up. With
    /// <paramref name="skipIfBusy"/> a caller (the watchdog) returns at once when another
    /// ensure is already in flight instead of queueing behind a spawn that can take 20 s.
    /// </summary>
    public bool EnsureSupervisor(bool skipIfBusy = false)
    {
        int wait = skipIfBusy ? 0 : (int)(ActionTimeoutSeconds * 1000);
        if (!EnsureGate.Wait(wait)) return IsAlive;
        try
        {
            return EnsureSupervisorCore();
        }
        finally
        {
            EnsureGate.Release();
        }
    }

    /// <summary>
    /// Write a command for the supervisor to pick up. Atomic: temp file in the same directory,
    /// flushed to disk, then moved into place, so the supervisor never reads a half-written
    /// {id, action, at} document.
    /// </summary>
    public void Send(string verb)
    {
        if (verb is not ("start" or "stop" or "restart" or "shutdown"))
        {
            throw new ArgumentException("unknown action: " + verb, nameof(verb));
        }

        EnsureRuntimeDir();
        string json = "{\"id\":\"" + Guid.NewGuid().ToString("N")
            + "\",\"action\":\"" + verb
            + "\",\"at\":\"" + DateTimeOffset.UtcNow.ToString("o", CultureInfo.InvariantCulture)
            + "\"}";
        string temp = Path.Combine(AppPaths.RuntimeDir, "cmd." + Guid.NewGuid().ToString("N") + ".tmp");
        try
        {
            byte[] bytes = Encoding.UTF8.GetBytes(json);
            using (var stream = new FileStream(temp, FileMode.CreateNew, FileAccess.Write, FileShare.None))
            {
                stream.Write(bytes, 0, bytes.Length);
                stream.Flush(true);
            }
            File.Move(temp, AppPaths.CmdFile, true);
        }
        catch (Exception ex) when (ex is IOException || ex is UnauthorizedAccessException)
        {
            DeleteQuietly(temp);
            TrayLog.Write("send: cannot write " + AppPaths.CmdFile + ": " + ex.Message);
            throw new IOException("cannot write " + AppPaths.CmdFile, ex);
        }
        TrayLog.Write("send: " + verb);
    }

    private bool EnsureSupervisorCore()
    {
        EnsureRuntimeDir();

        int? pid = SupervisorPid;
        TimeSpan? age = HeartbeatAge;
        bool fresh = age is TimeSpan ageValue && ageValue.TotalSeconds <= HeartbeatStaleSeconds;

        if (pid is int livePid && fresh && Interop.ProcessAlive(livePid))
        {
            // Adoption is the normal path, not the exception: the supervisor outlives every UI
            // that talks to it by design.
            TrayLog.Write(string.Format(
                CultureInfo.InvariantCulture,
                "adopt: supervisor pid {0} alive, heartbeat {1:0.0}s old",
                livePid,
                age.Value.TotalSeconds));
            return true;
        }

        bool up = SpawnSupervisor();
        if (!up && pid is null)
        {
            // One retry, never a loop: a lock whose owner has just died can refuse the newcomer
            // for a tick, and clearing the dead owner's leftovers makes the retry independent.
            TrayLog.Write("recover: spawn did not prove life; clearing a dead owner's state and retrying once");
            ClearStaleState();
            up = SpawnSupervisor();
        }

        if (!up)
        {
            TrayLog.Write("fail: no supervisor after spawn — the window opens attached to nothing");
            return false;
        }

        TrayLog.Write(string.Format(
            CultureInfo.InvariantCulture,
            "spawn: supervisor pid {0} alive, heartbeat fresh",
            (SupervisorPid ?? LastSpawnPid)?.ToString(CultureInfo.InvariantCulture) ?? "?"));
        return true;
    }

    private bool SpawnSupervisor()
    {
        // A supervisor that died hard can leave status.json still claiming "running"; the wait
        // below would then read a lie. Remove both so the only evidence is the new one's.
        DeleteQuietly(AppPaths.StatusFile);
        DeleteQuietly(AppPaths.HeartbeatFile);

        string python = AppPaths.PythonExe;
        if (!File.Exists(python))
        {
            TrayLog.Write("spawn: refused, venv interpreter missing at " + python);
            return false;
        }

        string commandLine = BuildCommandLine(python);
        // The decision, immediately above the spawn it causes: one glance in tray.log tells a
        // reader why a supervisor appeared.
        TrayLog.Write("spawn: launching " + commandLine);

        EnsurePythonPath();

        var security = new Interop.SecurityAttributes
        {
            nLength = Marshal.SizeOf<Interop.SecurityAttributes>(),
            lpSecurityDescriptor = IntPtr.Zero,
            bInheritHandle = 1,
        };

        IntPtr logHandle = Interop.CreateFile(
            AppPaths.SupervisorLog,
            Interop.FileAppendData,
            Interop.FileShareRead | Interop.FileShareWrite,
            ref security,
            Interop.OpenAlways,
            Interop.FileAttributeNormal,
            IntPtr.Zero);

        if (logHandle == IntPtr.Zero || logHandle == Interop.InvalidHandleValue)
        {
            TrayLog.Write("spawn: cannot open supervisor.log (win32 " + Marshal.GetLastWin32Error().ToString(CultureInfo.InvariantCulture) + ")");
            return false;
        }

        try
        {
            var startup = new Interop.StartupInfo
            {
                cb = Marshal.SizeOf<Interop.StartupInfo>(),
                dwFlags = Interop.StartfUseStdHandles | Interop.StartfUseShowWindow,
                wShowWindow = Interop.SwHide,
                hStdInput = Interop.InvalidHandleValue,
                hStdOutput = logHandle,
                hStdError = logHandle,
            };

            string workingDirectory = Directory.Exists(AppPaths.AppDir) ? AppPaths.AppDir : Environment.CurrentDirectory;

            bool created = Interop.CreateProcess(
                null,
                commandLine,
                IntPtr.Zero,
                IntPtr.Zero,
                true,
                Interop.CreationFlags(),
                IntPtr.Zero,
                workingDirectory,
                ref startup,
                out Interop.ProcessInformation processInformation);

            if (!created)
            {
                TrayLog.Write("spawn: CreateProcess failed (win32 " + Marshal.GetLastWin32Error().ToString(CultureInfo.InvariantCulture) + ")");
                return false;
            }

            Interop.CloseHandle(processInformation.hThread);
            Interop.CloseHandle(processInformation.hProcess);
            LastSpawnPid = processInformation.dwProcessId;
        }
        finally
        {
            Interop.CloseHandle(logHandle);
        }

        return WaitForProofOfLife();
    }

    private static bool WaitForProofOfLife()
    {
        DateTime deadline = DateTime.UtcNow.AddSeconds(ActionTimeoutSeconds);
        while (DateTime.UtcNow < deadline)
        {
            int? pid = ReadPublishedPid() ?? ReadStatusPid();
            TimeSpan? age = null;
            try
            {
                if (File.Exists(AppPaths.HeartbeatFile))
                {
                    age = DateTime.UtcNow - File.GetLastWriteTimeUtc(AppPaths.HeartbeatFile);
                }
            }
            catch (IOException)
            {
            }

            if (pid is int live
                && Interop.ProcessAlive(live)
                && age is TimeSpan fresh
                && fresh.TotalSeconds <= HeartbeatStaleSeconds)
            {
                return true;
            }
            Thread.Sleep(SpawnPollMilliseconds);
        }
        return false;
    }

    private static string BuildCommandLine(string python)
    {
        var builder = new StringBuilder();
        AppendArgument(builder, python);
        builder.Append(" -m shockbox_tui.supervisor --app-dir ");
        AppendArgument(builder, Path.TrimEndingDirectorySeparator(AppPaths.AppDir));
        builder.Append(" --port ").Append(AppPaths.Port.ToString(CultureInfo.InvariantCulture));
        return builder.ToString();
    }

    private static void AppendArgument(StringBuilder builder, string value)
    {
        builder.Append('"').Append(value).Append('"');
    }

    /// <summary>
    /// control.py does env.setdefault("PYTHONPATH", &lt;app&gt;/tools/tui) before spawning, because
    /// the supervisor package lives there rather than in site-packages. Setting it on this
    /// process is enough: CreateProcess inherits the block.
    /// </summary>
    private static void EnsurePythonPath()
    {
        if (!string.IsNullOrEmpty(Environment.GetEnvironmentVariable("PYTHONPATH"))) return;
        string tools = Path.Combine(AppPaths.AppDir, "tools", "tui");
        if (Directory.Exists(tools))
        {
            Environment.SetEnvironmentVariable("PYTHONPATH", tools, EnvironmentVariableTarget.Process);
        }
    }

    private static int? ReadPublishedPid()
    {
        try
        {
            if (!File.Exists(AppPaths.SupervisorPidFile)) return null;
            string text = File.ReadAllText(AppPaths.SupervisorPidFile).Trim();
            if (int.TryParse(text, NumberStyles.Integer, CultureInfo.InvariantCulture, out int pid) && pid > 0)
            {
                return pid;
            }
        }
        catch (IOException)
        {
        }
        catch (UnauthorizedAccessException)
        {
        }
        return null;
    }

    private static int? ReadStatusPid()
    {
        try
        {
            if (!File.Exists(AppPaths.StatusFile)) return null;
            using JsonDocument document = JsonDocument.Parse(File.ReadAllText(AppPaths.StatusFile));
            if (document.RootElement.ValueKind != JsonValueKind.Object) return null;
            foreach (string key in new[] { "supervisor_pid", "pid" })
            {
                if (document.RootElement.TryGetProperty(key, out JsonElement value)
                    && value.ValueKind == JsonValueKind.Number
                    && value.TryGetInt32(out int pid)
                    && pid > 0)
                {
                    return pid;
                }
            }
        }
        catch (IOException)
        {
        }
        catch (UnauthorizedAccessException)
        {
        }
        catch (JsonException)
        {
        }
        return null;
    }

    private static void ClearStaleState()
    {
        // Only reached when no pid is known: whatever is in these files names a process the OS
        // has already released, so removing it cannot orphan a live supervisor.
        DeleteQuietly(AppPaths.SupervisorPidFile);
        DeleteQuietly(AppPaths.SupervisorLockFile);
    }

    private static void DeleteQuietly(string path)
    {
        try
        {
            if (File.Exists(path)) File.Delete(path);
        }
        catch (IOException)
        {
            // Held by a live supervisor: leaving it is correct, and harmless.
        }
        catch (UnauthorizedAccessException)
        {
        }
    }

    private static void EnsureRuntimeDir()
    {
        try
        {
            Directory.CreateDirectory(AppPaths.RuntimeDir);
        }
        catch (IOException)
        {
        }
        catch (UnauthorizedAccessException)
        {
        }
    }
}
