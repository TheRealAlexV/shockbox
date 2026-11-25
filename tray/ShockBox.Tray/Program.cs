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

    [STAThread]
    private static int Main()
    {
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
