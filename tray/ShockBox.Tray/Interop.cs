using System.Runtime.InteropServices;

namespace ShockBox.Tray;

/// <summary>
/// The only Win32 surface this app needs: prove a pid is alive without killing it, spawn a
/// detached process with its stdout on a file, and talk to the running instance's hidden window.
/// </summary>
internal static class Interop
{
    internal static readonly IntPtr InvalidHandleValue = new(-1);

    internal const uint ProcessQueryLimitedInformation = 0x1000;
    internal const int ErrorAccessDenied = 5;

    // subprocess.DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP, and CREATE_NO_WINDOW only when
    // SHOCKBOX_TUI_WINDOWED is set — the same three flags control.py:_detach_flags uses.
    internal const uint DetachedProcess = 0x00000008;
    internal const uint CreateNewProcessGroup = 0x00000200;
    internal const uint CreateNoWindow = 0x08000000;

    internal const int StartfUseStdHandles = 0x00000100;
    internal const int StartfUseShowWindow = 0x00000001;
    internal const short SwHide = 0;

    internal const uint FileShareRead = 0x00000001;
    internal const uint FileShareWrite = 0x00000002;
    internal const uint FileAppendData = 0x00000004;
    internal const uint OpenAlways = 4;
    internal const uint FileAttributeNormal = 0x00000080;

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    internal struct StartupInfo
    {
        public int cb;
        public string? lpReserved;
        public string? lpDesktop;
        public string? lpTitle;
        public int dwX;
        public int dwY;
        public int dwXSize;
        public int dwYSize;
        public int dwXCountChars;
        public int dwYCountChars;
        public int dwFillAttribute;
        public int dwFlags;
        public short wShowWindow;
        public short cbReserved2;
        public IntPtr lpReserved2;
        public IntPtr hStdInput;
        public IntPtr hStdOutput;
        public IntPtr hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    internal struct ProcessInformation
    {
        public IntPtr hProcess;
        public IntPtr hThread;
        public int dwProcessId;
        public int dwThreadId;
    }

    [StructLayout(LayoutKind.Sequential)]
    internal struct SecurityAttributes
    {
        public int nLength;
        public IntPtr lpSecurityDescriptor;
        public int bInheritHandle;
    }

    [StructLayout(LayoutKind.Sequential)]
    internal struct CopyDataStruct
    {
        public IntPtr dwData;
        public int cbData;
        public IntPtr lpData;
    }

    /// <summary>
    /// Exists, whatever its owner. An access-denied handle means alive-but-uninspectable (a
    /// supervisor owned by SYSTEM reads exactly like that), which is the same verdict as
    /// supervisor.py's pid_alive. Only a missing pid is dead.
    /// </summary>
    internal static bool ProcessAlive(int pid)
    {
        if (pid <= 0) return false;
        IntPtr handle = OpenProcess(ProcessQueryLimitedInformation, false, pid);
        if (handle == IntPtr.Zero) return Marshal.GetLastWin32Error() == ErrorAccessDenied;
        CloseHandle(handle);
        return true;
    }

    internal static uint CreationFlags()
    {
        uint flags = DetachedProcess | CreateNewProcessGroup;
        if (!string.IsNullOrEmpty(Environment.GetEnvironmentVariable("SHOCKBOX_TUI_WINDOWED")))
        {
            flags |= CreateNoWindow;
        }
        return flags;
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    internal static extern IntPtr OpenProcess(uint desiredAccess, [MarshalAs(UnmanagedType.Bool)] bool inheritHandle, int processId);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool CloseHandle(IntPtr handle);

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool CreateProcess(
        string? applicationName,
        string commandLine,
        IntPtr processAttributes,
        IntPtr threadAttributes,
        [MarshalAs(UnmanagedType.Bool)] bool inheritHandles,
        uint creationFlags,
        IntPtr environment,
        string? currentDirectory,
        ref StartupInfo startupInfo,
        out ProcessInformation processInformation);

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    internal static extern IntPtr CreateFile(
        string fileName,
        uint desiredAccess,
        uint shareMode,
        ref SecurityAttributes securityAttributes,
        uint creationDisposition,
        uint flagsAndAttributes,
        IntPtr templateFile);

    [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    internal static extern uint RegisterWindowMessage(string message);

    [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    internal static extern IntPtr FindWindow(string? className, string? windowName);

    [DllImport("user32.dll", SetLastError = true)]
    internal static extern IntPtr SendMessage(IntPtr hWnd, int message, IntPtr wParam, ref CopyDataStruct lParam);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool SetForegroundWindow(IntPtr hWnd);

    [DllImport("user32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool DestroyIcon(IntPtr handle);
}
