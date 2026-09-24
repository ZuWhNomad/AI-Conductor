// Conductor 2.0 launcher (Windows). Built with the .NET Framework compiler that ships with Windows:
//   scripts\build-launcher.cmd  ->  Conductor.exe in the repo root
// Double-click behaviour: find Node, install dependencies on first run, start the app hidden, wait
// for its URL, open the browser, and show a small window with a Stop button. C# 5 syntax on purpose
// (the in-box csc.exe is old).
using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Net;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Windows.Forms;

static class Launcher
{
    const string Title = "Conductor 2.0";

    [STAThread]
    static int Main(string[] args)
    {
        string root = AppDomain.CurrentDomain.BaseDirectory.TrimEnd('\\');
        Directory.SetCurrentDirectory(root);
        string stateDir = Environment.GetEnvironmentVariable("CONDUCTOR_HOME");
        if (string.IsNullOrEmpty(stateDir) && Directory.Exists(Path.Combine(root, ".state"))) stateDir = Path.Combine(root, ".state"); // a dev checkout: own state + port (same rule as core/paths.mjs)
        if (string.IsNullOrEmpty(stateDir)) stateDir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".conductor2");
        Directory.CreateDirectory(stateDir);
        int port = ReadPort(Path.Combine(stateDir, "config.json"));
        string url = "http://127.0.0.1:" + port;

        if (IsUp(url))
        {
            OpenBrowser(url);
            MessageBox.Show("Conductor 2.0 is already running at " + url + "\n\nYour browser has been opened to it.", Title, MessageBoxButtons.OK, MessageBoxIcon.Information);
            return 0;
        }

        string node = FindNode();
        if (node == null)
        {
            if (MessageBox.Show("Conductor needs Node.js 22 or newer, which was not found on this computer.\n\nOpen the Node.js download page now? (Install it, then double-click Conductor again.)", Title, MessageBoxButtons.YesNo, MessageBoxIcon.Warning) == DialogResult.Yes)
                OpenBrowser("https://nodejs.org/en/download");
            return 1;
        }
        string version = Capture(node, "-p \"process.versions.node\"", root).Trim();
        int major = 0;
        int.TryParse(version.Split('.')[0], out major);
        if (major < 22)
        {
            MessageBox.Show("Node.js " + version + " was found, but Conductor needs version 22 or newer.\n\nInstall the current version from https://nodejs.org and try again.", Title, MessageBoxButtons.OK, MessageBoxIcon.Warning);
            return 1;
        }

        string sdk = Path.Combine(root, "node_modules", "@anthropic-ai", "claude-agent-sdk");
        if (!Directory.Exists(sdk))
        {
            string npm = Path.Combine(Path.GetDirectoryName(node), "npm.cmd");
            if (!File.Exists(npm)) npm = "npm";
            var install = new ProcessStartInfo("cmd.exe", "/c \"title Conductor 2.0 - first-run setup && echo Installing Conductor dependencies (first run only, needs internet)... && \"" + npm + "\" install --no-fund --no-audit\"");
            install.WorkingDirectory = root;
            install.UseShellExecute = true;
            Process ip = Process.Start(install);
            ip.WaitForExit();
            if (ip.ExitCode != 0 || !Directory.Exists(sdk))
            {
                MessageBox.Show("Installing dependencies failed (npm exit code " + ip.ExitCode + ").\n\nCheck your internet connection and try again.", Title, MessageBoxButtons.OK, MessageBoxIcon.Error);
                return 1;
            }
        }

        string logPath = Path.Combine(stateDir, "launcher.log");
        StreamWriter log = new StreamWriter(logPath, true, Encoding.UTF8);
        log.AutoFlush = true;
        log.WriteLine("---- " + DateTime.Now.ToString("s") + " starting from " + root);

        var psi = new ProcessStartInfo(node, "\"" + Path.Combine(root, "bin", "conductor.mjs") + "\" start");
        psi.WorkingDirectory = root;
        psi.UseShellExecute = false;
        psi.CreateNoWindow = true;
        psi.RedirectStandardOutput = true;
        psi.RedirectStandardError = true;
        Process proc = Process.Start(psi);
        string foundUrl = null;
        var tail = new StringBuilder();
        DataReceivedEventHandler onLine = delegate(object s, DataReceivedEventArgs e)
        {
            if (e.Data == null) return;
            log.WriteLine(e.Data);
            lock (tail) { tail.AppendLine(e.Data); if (tail.Length > 6000) tail.Remove(0, tail.Length - 6000); }
            Match m = Regex.Match(e.Data, @"running at (http://\S+)");
            if (m.Success) foundUrl = m.Groups[1].Value;
        };
        proc.OutputDataReceived += onLine;
        proc.ErrorDataReceived += onLine;
        proc.BeginOutputReadLine();
        proc.BeginErrorReadLine();

        for (int i = 0; i < 160 && foundUrl == null && !proc.HasExited; i++) Thread.Sleep(250);
        if (foundUrl == null)
        {
            Thread.Sleep(400);
            string t; lock (tail) t = tail.ToString();
            MessageBox.Show("Conductor did not start.\n\n" + Last(t, 1500) + "\n\nFull log: " + logPath, Title, MessageBoxButtons.OK, MessageBoxIcon.Error);
            KillTree(proc);
            return 1;
        }

        Application.EnableVisualStyles();
        Application.Run(new StatusForm(foundUrl, proc, tail, logPath, stateDir));
        KillTree(proc);
        log.WriteLine("---- " + DateTime.Now.ToString("s") + " stopped");
        return 0;
    }

    static int ReadPort(string configPath)
    {
        try
        {
            if (File.Exists(configPath))
            {
                Match m = Regex.Match(File.ReadAllText(configPath), "\"port\"\\s*:\\s*(\\d+)");
                if (m.Success) return int.Parse(m.Groups[1].Value);
            }
        }
        catch { }
        return 47474;
    }

    public static int ReadPid(string pidPath)
    {
        try
        {
            if (File.Exists(pidPath))
            {
                Match m = Regex.Match(File.ReadAllText(pidPath), "\"pid\"\\s*:\\s*(\\d+)");
                if (m.Success) return int.Parse(m.Groups[1].Value);
            }
        }
        catch { }
        return 0;
    }

    public static bool IsUp(string url)
    {
        try
        {
            var req = (HttpWebRequest)WebRequest.Create(url + "/api/state");
            req.Timeout = 1500;
            using (var res = (HttpWebResponse)req.GetResponse()) return (int)res.StatusCode == 200;
        }
        catch { return false; }
    }

    static string FindNode()
    {
        string path = Environment.GetEnvironmentVariable("PATH") ?? "";
        foreach (string dir in path.Split(';'))
        {
            if (dir.Trim().Length == 0) continue;
            string p = Path.Combine(dir.Trim(), "node.exe");
            if (File.Exists(p)) return p;
        }
        string[] guesses = {
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "nodejs", "node.exe"),
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86), "nodejs", "node.exe"),
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs", "nodejs", "node.exe"),
        };
        foreach (string g in guesses) if (File.Exists(g)) return g;
        return null;
    }

    static string Capture(string exe, string args, string cwd)
    {
        try
        {
            var psi = new ProcessStartInfo(exe, args);
            psi.WorkingDirectory = cwd; psi.UseShellExecute = false; psi.CreateNoWindow = true; psi.RedirectStandardOutput = true;
            using (Process p = Process.Start(psi)) { string o = p.StandardOutput.ReadToEnd(); p.WaitForExit(10000); return o; }
        }
        catch { return ""; }
    }

    public static void OpenBrowser(string url)
    {
        try { Process.Start(new ProcessStartInfo("cmd.exe", "/c start \"\" \"" + url + "\"") { UseShellExecute = false, CreateNoWindow = true }); } catch { }
    }

    public static void KillTree(Process p)
    {
        try
        {
            if (p == null || p.HasExited) return;
            var k = new ProcessStartInfo("taskkill", "/pid " + p.Id + " /T /F") { UseShellExecute = false, CreateNoWindow = true };
            using (Process kp = Process.Start(k)) kp.WaitForExit(5000);
        }
        catch { }
    }

    public static string Last(string s, int n) { return s.Length <= n ? s : s.Substring(s.Length - n); }
}

class StatusForm : Form
{
    Process proc;
    readonly StringBuilder tail;
    readonly string logPath;
    readonly string url;
    readonly string pidPath;
    readonly System.Windows.Forms.Timer timer = new System.Windows.Forms.Timer();
    DateTime followUntil = DateTime.MinValue;

    public StatusForm(string url, Process proc, StringBuilder tail, string logPath, string stateDir)
    {
        this.proc = proc; this.tail = tail; this.logPath = logPath; this.url = url;
        this.pidPath = Path.Combine(stateDir, "server.pid");
        Text = "Conductor 2.0";
        StartPosition = FormStartPosition.CenterScreen;
        FormBorderStyle = FormBorderStyle.FixedDialog;
        MaximizeBox = false; MinimizeBox = true;
        ClientSize = new Size(420, 150);
        Font = new Font("Segoe UI", 10f);

        var label = new Label();
        label.Text = "Conductor 2.0 is running at\n" + url + "\n\nLeave this window open while you use Conductor.\nMinimize it if it is in the way.";
        label.SetBounds(16, 14, 388, 88);
        Controls.Add(label);

        var open = new Button(); open.Text = "Open in browser"; open.SetBounds(16, 108, 150, 30);
        open.Click += delegate { Launcher.OpenBrowser(url); };
        Controls.Add(open);

        var stop = new Button(); stop.Text = "Stop Conductor"; stop.SetBounds(254, 108, 150, 30);
        stop.Click += delegate { Close(); };
        Controls.Add(stop);

        timer.Interval = 1000;
        timer.Tick += delegate { OnTick(); };
        timer.Start();
    }

    void OnTick()
    {
        if (!proc.HasExited) { followUntil = DateTime.MinValue; return; }
        if (proc.ExitCode != 0)
        {
            timer.Stop();
            string t; lock (tail) t = tail.ToString();
            MessageBox.Show("Conductor stopped unexpectedly (exit code " + proc.ExitCode + ").\n\n" + Launcher.Last(t, 1500) + "\n\nFull log: " + logPath, "Conductor 2.0", MessageBoxButtons.OK, MessageBoxIcon.Error);
            Close();
            return;
        }
        // Exit 0: Quit, or an update relaunch. Probe /api/state up to the child's bind budget (20 s, same as CONDUCTOR_RELAUNCH_WAIT).
        if (followUntil == DateTime.MinValue) followUntil = DateTime.Now.AddSeconds(20);
        if (TryFollow()) { followUntil = DateTime.MinValue; return; }
        if (DateTime.Now >= followUntil) { timer.Stop(); Close(); }
    }

    bool TryFollow()
    {
        if (!Launcher.IsUp(url)) return false;
        int pid = Launcher.ReadPid(pidPath);
        if (pid <= 0) return false;
        try
        {
            Process next = Process.GetProcessById(pid);
            if (next.HasExited) return false;
            proc = next;
            return true;
        }
        catch { return false; }
    }

    protected override void OnFormClosed(FormClosedEventArgs e)
    {
        timer.Stop();
        Launcher.KillTree(proc);
        base.OnFormClosed(e);
    }
}
