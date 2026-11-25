using System.Globalization;

namespace ShockBox.Tray;

/// <summary>
/// Lifecycle and watchdog decisions, one timestamped line each, in the same runtime dir the
/// supervisor logs to. The TUI's watchdog had exactly one real defect: its decisions went to a
/// stderr nobody captured, so a respawn looked like a mystery. This is that stream, kept.
/// </summary>
internal static class TrayLog
{
    private static readonly object Gate = new();

    public static void Write(string message)
    {
        try
        {
            Directory.CreateDirectory(AppPaths.RuntimeDir);
            string line = string.Format(
                CultureInfo.InvariantCulture,
                "{0} tray[{1}]: {2}{3}",
                DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss", CultureInfo.InvariantCulture),
                Environment.ProcessId,
                message,
                Environment.NewLine);
            lock (Gate)
            {
                File.AppendAllText(Path.Combine(AppPaths.RuntimeDir, "tray.log"), line);
            }
        }
        catch (IOException)
        {
            // A tray log that cannot be written must never take the tray down with it.
        }
        catch (UnauthorizedAccessException)
        {
        }
    }
}
