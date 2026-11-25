# dsh-screenshot: system-wide hotkey for Windows.
# Registers a RegisterHotKey binding and prints one line per event on stdout:
#   READY 0 | READY deferred | ACQUIRED | RELEASED | TRIGGER | ERROR <code>
# The binding is released while the DSH Desktop window is in the foreground so the
# in-app shortcut can handle it; it is re-acquired when another app gets focus.
#
# Usage: powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -STA -File hotkey.ps1 -Vk 83 -Mods 3 -AppName "DSH Desktop" -ParentPid 1234
# Compile check only: powershell -NoProfile -ExecutionPolicy Bypass -File hotkey.ps1 -Vk 83 -Mods 3 -Check

param(
  [Parameter(Mandatory = $true)][int]$Vk,
  [Parameter(Mandatory = $true)][int]$Mods,
  [string]$AppName = '',
  [int]$ParentPid = 0,
  [switch]$Check
)

$ErrorActionPreference = 'Stop'

$source = @'
using System;
using System.Diagnostics;
using System.Drawing;
using System.Runtime.InteropServices;
using System.Windows.Forms;

public static class DshHotkey
{
    private const int WM_HOTKEY = 0x0312;
    private const int HotkeyId = 0x4453;

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool RegisterHotKey(IntPtr hWnd, int id, uint fsModifiers, uint vk);
    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool UnregisterHotKey(IntPtr hWnd, int id);
    [DllImport("user32.dll")]
    private static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);

    private static uint vk;
    private static uint mods;
    private static string appName = "";
    private static int parentPid;

    public static int Run(int vkValue, int modsValue, string appValue, int parentValue)
    {
        vk = (uint)vkValue;
        mods = (uint)modsValue;
        appName = appValue ?? "";
        parentPid = parentValue;

        Application.EnableVisualStyles();
        Application.Run(new HotkeyForm());
        return 0;
    }

    private sealed class HotkeyForm : Form
    {
        private readonly Timer timer;
        private bool registered;
        private bool announced;

        public HotkeyForm()
        {
            FormBorderStyle = FormBorderStyle.None;
            ShowInTaskbar = false;
            StartPosition = FormStartPosition.Manual;
            Location = new Point(-32000, -32000);
            Size = new Size(1, 1);
            Opacity = 0;

            timer = new Timer();
            timer.Interval = 400;
            timer.Tick += OnTick;
            timer.Start();
            Sync();
        }

        protected override void SetVisibleCore(bool value)
        {
            if (!IsHandleCreated && value)
            {
                CreateHandle();
            }
            base.SetVisibleCore(false);
        }

        protected override void WndProc(ref Message message)
        {
            if (message.Msg == WM_HOTKEY && message.WParam.ToInt32() == HotkeyId)
            {
                Console.Out.WriteLine("TRIGGER");
                Console.Out.Flush();
            }
            base.WndProc(ref message);
        }

        protected override void Dispose(bool disposing)
        {
            if (registered)
            {
                UnregisterHotKey(Handle, HotkeyId);
                registered = false;
            }
            if (disposing)
            {
                timer.Stop();
                timer.Dispose();
            }
            base.Dispose(disposing);
        }

        private void OnTick(object sender, EventArgs e)
        {
            Sync();
        }

        private void Sync()
        {
            bool foreground = IsDshForeground();
            if (foreground)
            {
                if (registered)
                {
                    UnregisterHotKey(Handle, HotkeyId);
                    registered = false;
                    Console.Out.WriteLine("RELEASED");
                    Console.Out.Flush();
                }
                if (!announced)
                {
                    announced = true;
                    Console.Out.WriteLine("READY deferred");
                    Console.Out.Flush();
                }
            }
            else if (!registered)
            {
                if (RegisterHotKey(Handle, HotkeyId, mods, vk))
                {
                    registered = true;
                    Console.Out.WriteLine("ACQUIRED");
                    Console.Out.Flush();
                    if (!announced)
                    {
                        announced = true;
                        Console.Out.WriteLine("READY 0");
                        Console.Out.Flush();
                    }
                }
                else
                {
                    int error = Marshal.GetLastWin32Error();
                    Console.Out.WriteLine("ERROR " + error);
                    Console.Out.Flush();
                    Environment.Exit(1);
                }
            }
        }
    }

    private static bool IsDshForeground()
    {
        IntPtr window = GetForegroundWindow();
        if (window == IntPtr.Zero) return false;
        uint pid;
        GetWindowThreadProcessId(window, out pid);
        if (parentPid != 0 && (int)pid == parentPid) return true;
        if (appName.Length > 0)
        {
            try
            {
                Process process = Process.GetProcessById((int)pid);
                if (string.Equals(process.ProcessName, appName, StringComparison.OrdinalIgnoreCase)) return true;
            }
            catch
            {
            }
        }
        return false;
    }
}
'@

try {
  Add-Type -AssemblyName System.Windows.Forms
  Add-Type -AssemblyName System.Drawing
  Add-Type -TypeDefinition $source -ReferencedAssemblies @('System.dll', 'System.Windows.Forms.dll', 'System.Drawing.dll')
  if ($Check) {
    Write-Output 'COMPILE OK'
    exit 0
  }
  [void][DshHotkey]::Run($Vk, $Mods, $AppName, $ParentPid)
  exit 0
} catch {
  [Console]::Out.WriteLine("ERROR 1")
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 1
}
