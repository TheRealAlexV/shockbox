using System.Globalization;
using System.Net.Http;
using System.Text.Json;
using System.Threading;

namespace ShockBox.Tray;

/// <summary>One immutable reading of everything the tray renders.</summary>
internal sealed class StatusSnapshot
{
    public DateTime ReadAtUtc { get; init; } = DateTime.UtcNow;

    public string State { get; init; } = "no-supervisor";

    public int? SupervisorPid { get; init; }

    public int? NodePid { get; init; }

    public bool? NodeAlive { get; init; }

    public bool SupervisorAlive { get; init; }

    public double? HeartbeatAgeSeconds { get; init; }

    public string? Since { get; init; }

    public int? Restarts { get; init; }

    public string? LastError { get; init; }

    public int? HealthPid { get; init; }

    public string? Version { get; init; }

    public int? HealthPort { get; init; }

    public int? UptimeSeconds { get; init; }

    public string? ObsState { get; init; }

    public string? ObsScene { get; init; }

    public int? ModuleCount { get; init; }

    public IReadOnlyList<string> ModulesDown { get; init; } = Array.Empty<string>();

    public string? StatusError { get; init; }

    public string? HealthError { get; init; }

    public string? ModulesError { get; init; }

    public bool HealthOk => HealthError is null && UptimeSeconds is not null;
}

/// <summary>
/// One timer at 1.5 s reading status.json, the heartbeat age, /health and /api/modules. Each
/// source is read inside its own guard, so a supervisor that is down costs a URL timeout and
/// nothing else: the status line stays readable while /health is unreachable, and vice versa.
/// </summary>
internal sealed class StatusPoller : IDisposable
{
    private static readonly HttpClient Http = new HttpClient { Timeout = TimeSpan.FromMilliseconds(1500) };
    private static readonly TimeSpan ReadTimeout = TimeSpan.FromMilliseconds(1200);

    private readonly Supervisor _supervisor;
    // Fully qualified: "Timer" is ambiguous between System.Threading and System.Windows.Forms.
    private readonly System.Threading.Timer _timer;
    private int _busy;
    private int _disposed;

    public StatusPoller(Supervisor supervisor, TimeSpan? interval = null)
    {
        _supervisor = supervisor;
        _timer = new System.Threading.Timer(
            _ => _ = PollAsync(),
            null,
            TimeSpan.Zero,
            interval ?? TimeSpan.FromMilliseconds(1500));
    }

    /// <summary>Raised on a thread-pool thread. Handlers must marshal to the UI thread.</summary>
    public event EventHandler<StatusSnapshot>? Updated;

    public StatusSnapshot Snapshot { get; private set; } = new StatusSnapshot();

    public void Dispose()
    {
        if (Interlocked.Exchange(ref _disposed, 1) == 1) return;
        _timer.Dispose();
    }

    private async Task PollAsync()
    {
        if (Volatile.Read(ref _disposed) == 1) return;
        if (Interlocked.Exchange(ref _busy, 1) == 1) return;
        try
        {
            StatusSnapshot snapshot = await ReadAsync().ConfigureAwait(false);
            Snapshot = snapshot;
            Updated?.Invoke(this, snapshot);
        }
        catch (Exception ex)
        {
            // A poller must never take the tray down; the next tick retries.
            TrayLog.Write("poll: " + Describe(ex));
        }
        finally
        {
            Interlocked.Exchange(ref _busy, 0);
        }
    }

    private async Task<StatusSnapshot> ReadAsync()
    {
        // status.json ---------------------------------------------------------------
        JsonDocument? statusDocument = null;
        string? statusError = null;
        try
        {
            if (File.Exists(AppPaths.StatusFile))
            {
                string text = await File.ReadAllTextAsync(AppPaths.StatusFile).ConfigureAwait(false);
                if (!string.IsNullOrWhiteSpace(text))
                {
                    statusDocument = JsonDocument.Parse(text);
                }
            }
        }
        catch (Exception ex)
        {
            statusError = Describe(ex);
        }

        // /health and /api/modules, in parallel and independently ---------------------
        Task<(string? Text, string? Error)> healthTask = FetchAsync("health");
        Task<(string? Text, string? Error)> modulesTask = FetchAsync("api/modules");
        await Task.WhenAll(healthTask, modulesTask).ConfigureAwait(false);
        (string? Text, string? Error) health = healthTask.Result;
        (string? Text, string? Error) modules = modulesTask.Result;

        string state = "no-supervisor";
        int? supervisorPid = null;
        int? nodePid = null;
        int? restarts = null;
        bool? nodeAlive = null;
        string? since = null;
        string? lastError = null;

        try
        {
            if (statusDocument is not null && statusDocument.RootElement.ValueKind == JsonValueKind.Object)
            {
                JsonElement root = statusDocument.RootElement;
                state = JsonString(root, "state") ?? state;
                supervisorPid = JsonInt(root, "supervisor_pid") ?? JsonInt(root, "pid");
                nodePid = JsonInt(root, "node_pid");
                restarts = JsonInt(root, "restarts");
                nodeAlive = JsonBool(root, "node_alive");
                since = JsonString(root, "since");
                lastError = JsonString(root, "last_error");
            }
        }
        finally
        {
            statusDocument?.Dispose();
        }

        int? healthPid = null;
        int? healthPort = null;
        int? uptime = null;
        string? version = null;
        string? obsState = null;
        string? obsScene = null;
        string? healthError = health.Error;
        if (health.Text is not null)
        {
            try
            {
                using JsonDocument document = JsonDocument.Parse(health.Text);
                JsonElement root = document.RootElement;
                healthPid = JsonInt(root, "pid");
                healthPort = JsonInt(root, "port");
                uptime = JsonInt(root, "uptime");
                version = JsonString(root, "version");
                if (root.ValueKind == JsonValueKind.Object
                    && root.TryGetProperty("obs", out JsonElement obs)
                    && obs.ValueKind == JsonValueKind.Object)
                {
                    obsState = JsonString(obs, "state");
                    obsScene = JsonString(obs, "scene");
                }
            }
            catch (JsonException ex)
            {
                healthError = Describe(ex);
            }
        }

        int? moduleCount = null;
        var modulesDown = new List<string>();
        string? modulesError = modules.Error;
        if (modules.Text is not null)
        {
            try
            {
                using JsonDocument document = JsonDocument.Parse(modules.Text);
                if (document.RootElement.ValueKind == JsonValueKind.Object
                    && document.RootElement.TryGetProperty("modules", out JsonElement list)
                    && list.ValueKind == JsonValueKind.Array)
                {
                    int count = 0;
                    foreach (JsonElement module in list.EnumerateArray())
                    {
                        count++;
                        string? status = JsonString(module, "status");
                        if (!string.Equals(status, "up", StringComparison.Ordinal))
                        {
                            modulesDown.Add(JsonString(module, "id") ?? "?");
                        }
                    }
                    moduleCount = count;
                }
            }
            catch (JsonException ex)
            {
                modulesError = Describe(ex);
            }
        }

        TimeSpan? heartbeatAge = _supervisor.HeartbeatAge;

        return new StatusSnapshot
        {
            State = state,
            SupervisorPid = supervisorPid ?? _supervisor.SupervisorPid,
            NodePid = nodePid,
            NodeAlive = nodeAlive,
            SupervisorAlive = _supervisor.IsAlive,
            HeartbeatAgeSeconds = heartbeatAge?.TotalSeconds,
            Since = since,
            Restarts = restarts,
            LastError = lastError,
            HealthPid = healthPid,
            Version = version,
            HealthPort = healthPort,
            UptimeSeconds = uptime,
            ObsState = obsState,
            ObsScene = obsScene,
            ModuleCount = moduleCount,
            ModulesDown = modulesDown,
            StatusError = statusError,
            HealthError = healthError,
            ModulesError = modulesError,
        };
    }

    private static async Task<(string? Text, string? Error)> FetchAsync(string path)
    {
        try
        {
            using var timeout = new CancellationTokenSource(ReadTimeout);
            string text = await Http.GetStringAsync(new Uri(AppPaths.BaseUrl + path), timeout.Token).ConfigureAwait(false);
            return (text, null);
        }
        catch (Exception ex)
        {
            return (null, Describe(ex));
        }
    }

    private static string? JsonString(JsonElement element, string property)
    {
        return element.ValueKind == JsonValueKind.Object
            && element.TryGetProperty(property, out JsonElement value)
            && value.ValueKind == JsonValueKind.String
            ? value.GetString()
            : null;
    }

    private static int? JsonInt(JsonElement element, string property)
    {
        return element.ValueKind == JsonValueKind.Object
            && element.TryGetProperty(property, out JsonElement value)
            && value.ValueKind == JsonValueKind.Number
            && value.TryGetInt32(out int number)
            ? number
            : null;
    }

    private static bool? JsonBool(JsonElement element, string property)
    {
        if (element.ValueKind != JsonValueKind.Object || !element.TryGetProperty(property, out JsonElement value))
        {
            return null;
        }
        if (value.ValueKind == JsonValueKind.True) return true;
        if (value.ValueKind == JsonValueKind.False) return false;
        return null;
    }

    private static string Describe(Exception ex)
    {
        return ex.GetType().Name + ": " + ex.Message.Replace(Environment.NewLine, " ", StringComparison.Ordinal);
    }
}
