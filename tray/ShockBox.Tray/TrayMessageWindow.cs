using System.Drawing;
using System.Windows.Forms;

namespace ShockBox.Tray;

/// <summary>
/// A hidden top-level window that exists for exactly two jobs: it is the WM_COPYDATA target a
/// second launch finds by title, and it is where TaskbarCreated arrives after an explorer
/// restart. It is never shown, and it is also the tray's UI-thread marshal point (BeginInvoke).
/// </summary>
internal sealed class TrayMessageWindow : Form
{
    internal const string WindowTitle = "ShockBox.Tray.Signal";

    internal const int WmCopyData = 0x004A;

    private static readonly int TaskbarCreated = (int)Interop.RegisterWindowMessage("TaskbarCreated");

    public TrayMessageWindow()
    {
        Text = WindowTitle;
        ShowInTaskbar = false;
        ShowIcon = false;
        FormBorderStyle = FormBorderStyle.None;
        StartPosition = FormStartPosition.Manual;
        Size = new Size(1, 1);
        // Force the handle now: FindWindow has to see it from the second process, and a control
        // with no handle has nowhere to receive TaskbarCreated or WM_COPYDATA.
        _ = Handle;
    }

    /// <summary>A second instance asked to be folded into this one.</summary>
    public event EventHandler? ShowRequested;

    /// <summary>explorer.exe restarted: the tray icon must be re-added, Windows will not.</summary>
    public event EventHandler? TaskbarRecreated;

    protected override void WndProc(ref Message message)
    {
        if (message.Msg == WmCopyData)
        {
            ShowRequested?.Invoke(this, EventArgs.Empty);
            message.Result = new IntPtr(1);
            return;
        }

        if (TaskbarCreated != 0 && message.Msg == TaskbarCreated)
        {
            TaskbarRecreated?.Invoke(this, EventArgs.Empty);
            message.Result = IntPtr.Zero;
            return;
        }

        base.WndProc(ref message);
    }
}
