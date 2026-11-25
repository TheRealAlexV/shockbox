using System.Drawing;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace ShockBox.Tray;

/// <summary>
/// The ShockBox page, in a normal window. It is a shell, not a second UI: everything it shows is
/// the same HTML the browser and the OBS sources get from the node server. Created lazily on the
/// first show and torn down on close; closing it neither exits the app nor stops the server.
/// </summary>
internal sealed class MainForm : Form
{
    private readonly string _url;
    private WebView2? _web;
    private bool _initializing;

    public MainForm(string url)
    {
        _url = url;
        Text = "ShockBox";
        StartPosition = FormStartPosition.CenterScreen;
        MinimumSize = new Size(720, 480);
        Size = new Size(1280, 800);
    }

    /// <summary>
    /// Not next to the exe: the deployed tree lives at C:\OBS\ShockBox and may be read-only or
    /// shared, and a per-user folder also keeps a second copy from failing on a locked profile.
    /// </summary>
    private static string UserDataFolder => Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
        "ShockBox",
        "WebView2");

    protected override void OnVisibleChanged(EventArgs e)
    {
        base.OnVisibleChanged(e);
        if (Visible) StartWebView();
    }

    protected override void OnFormClosing(FormClosingEventArgs e)
    {
        if (e.CloseReason == CloseReason.WindowsShutDown || e.CloseReason == CloseReason.TaskManagerClosing)
        {
            base.OnFormClosing(e);
            return;
        }

        // Closing the window is not quitting: the supervisor and node are detached by design.
        // The web view is dropped so a closed window costs nothing; it is rebuilt on next show.
        e.Cancel = true;
        Hide();
        DisposeWebView();
        base.OnFormClosing(e);
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing) DisposeWebView();
        base.Dispose(disposing);
    }

    private async void StartWebView()
    {
        if (_web is not null || _initializing) return;
        _initializing = true;
        WebView2? web = null;
        try
        {
            string userDataFolder = UserDataFolder;
            Directory.CreateDirectory(userDataFolder);
            TrayLog.Write("webview: initializing, user data folder " + userDataFolder);

            web = new WebView2 { Dock = DockStyle.Fill };
            Controls.Add(web);

            CoreWebView2Environment environment = await CoreWebView2Environment.CreateAsync(null, userDataFolder, null);
            await web.EnsureCoreWebView2Async(environment);
            TrayLog.Write("webview: CoreWebView2 ready");
            _web = web;

            web.CoreWebView2.NavigationCompleted += OnNavigationCompleted;
            // Navigate(string) rather than the control's Source property: the property's type
            // differs between the WinForms and WPF wrappers, the CoreWebView2 method does not.
            web.CoreWebView2.Navigate(_url);
        }
        catch (Exception ex)
        {
            // Hosting a control is the one thing the shell probe never proved. A failure here is
            // the likely failure, so it must be visible in the window and in tray.log, not a
            // blank pane that reads as a hung app.
            TrayLog.Write("webview: init failed: " + ex.GetType().Name + ": " + ex.Message);
            if (web is not null)
            {
                Controls.Remove(web);
                web.Dispose();
            }
            _web = null;
            ShowFailure(ex);
        }
        finally
        {
            _initializing = false;
        }
    }

    private void OnNavigationCompleted(object? sender, CoreWebView2NavigationCompletedEventArgs e)
    {
        if (e.IsSuccess) return;
        string message = "Navigation to " + _url + " failed: " + e.WebErrorStatus;
        TrayLog.Write("webview: " + message);
        // Deferred: disposing the control from inside its own event would be reckless.
        BeginInvoke(new Action<Exception>(ShowFailure), new InvalidOperationException(message));
    }

    private void ShowFailure(Exception exception)
    {
        DisposeWebView();

        string runtime;
        try
        {
            runtime = CoreWebView2Environment.GetAvailableBrowserVersionString() ?? "not found";
        }
        catch (Exception ex)
        {
            runtime = "not usable (" + ex.GetType().Name + ": " + ex.Message + ")";
        }

        string details = string.Join(
            Environment.NewLine,
            "The ShockBox page could not be opened.",
            string.Empty,
            "URL:                    " + _url,
            "WebView2 user data:     " + UserDataFolder,
            "WebView2 runtime:       " + runtime,
            string.Empty,
            exception.GetType().Name + ": " + exception.Message,
            string.Empty,
            "Full details are in the tray log next to the supervisor log:",
            Path.Combine(AppPaths.RuntimeDir, "tray.log"));

        Controls.Clear();
        Controls.Add(new TextBox
        {
            Dock = DockStyle.Fill,
            Multiline = true,
            ReadOnly = true,
            WordWrap = true,
            ScrollBars = ScrollBars.Both,
            BackColor = SystemColors.Window,
            Text = details,
        });
    }

    private void DisposeWebView()
    {
        WebView2? web = _web;
        _web = null;
        if (web is null) return;
        if (web.CoreWebView2 is not null)
        {
            web.CoreWebView2.NavigationCompleted -= OnNavigationCompleted;
        }
        Controls.Remove(web);
        web.Dispose();
    }
}
