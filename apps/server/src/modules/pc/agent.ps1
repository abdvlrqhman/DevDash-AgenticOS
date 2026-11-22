#Requires -Version 5.1
<#
.SYNOPSIS
  DevDash PC Computer Use Agent (Tailscale-Only, Win32 + UI Automation + Full PC Control)
.DESCRIPTION
  Runs strictly on your PC's Tailscale IPv4 address and only accepts authenticated requests
  from your DevDash server's Tailscale IP. Includes a System Tray kill-switch.
#>
param(
  [string]$ConfigPath = "$env:LOCALAPPDATA\DevDash\pc-agent\config.json",
  [switch]$NoTray
)

$ErrorActionPreference = 'Stop'

if (-not (Test-Path $ConfigPath)) {
  Write-Error "Config not found at $ConfigPath. Run the DevDash PC installer first."
  exit 1
}

$script:Config = Get-Content -Raw -Path $ConfigPath | ConvertFrom-Json
$script:Paused = $false
$script:AllowShell = [bool]$script:Config.allowShell
$script:Running = $true
$script:Port = [int]$script:Config.port
$script:ExpectedTsIp = [string]$script:Config.tailscaleIp
$script:AllowedPeerIp = [string]$script:Config.vpsTailscaleIp
$script:Token = [string]$script:Config.token
$script:LogDir = Split-Path -Parent $ConfigPath
$script:LogFile = Join-Path $script:LogDir 'agent.log'
$script:ElementMap = @{}

function Write-AgentLog([string]$msg) {
  $line = "[{0}] {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $msg
  try { Add-Content -Path $script:LogFile -Value $line -ErrorAction SilentlyContinue } catch {}
  if ($NoTray) { Write-Host $line }
}

function Get-TailscaleExe {
  $candidates = @(
    'C:\Program Files\Tailscale\tailscale.exe',
    'C:\Program Files (x86)\Tailscale\tailscale.exe'
  )
  foreach ($c in $candidates) {
    if (Test-Path $c) { return $c }
  }
  $cmd = Get-Command tailscale.exe -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  return $null
}

function Get-LiveTailscaleIp {
  $exe = Get-TailscaleExe
  if ($exe) {
    try {
      $out = & $exe ip -4 2>$null
      if ($LASTEXITCODE -eq 0 -and $out) {
        $ip = ($out | Select-Object -First 1).Trim()
        if ($ip -match '^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}$') {
          return $ip
        }
      }
    } catch {}
  }
  # Fallback: inspect local network adapters for active 100.64.0.0/10 Tailscale interface
  try {
    $addrs = [System.Net.NetworkInformation.NetworkInterface]::GetAllNetworkInterfaces() |
      Where-Object { $_.OperationalStatus -eq 'Up' -and ($_.Name -match 'Tailscale' -or $_.Description -match 'Tailscale') } |
      ForEach-Object { $_.GetIPProperties().UnicastAddresses } |
      ForEach-Object { $_.Address.IPAddressToString }
    foreach ($a in $addrs) {
      if ($a -match '^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}$') {
        return $a
      }
    }
  } catch {}
  return $null
}

$nativeSource = @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Windows.Automation;
using System.Windows.Forms;

namespace DevDashPc {
    public static class Native {
        [DllImport("user32.dll")] private static extern bool SetProcessDPIAware();
        [DllImport("user32.dll")] private static extern bool SetProcessDpiAwarenessContext(IntPtr value);
        [DllImport("user32.dll")] private static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
        private delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
        [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr hWnd);
        [DllImport("user32.dll")] private static extern bool IsIconic(IntPtr hWnd);
        [DllImport("user32.dll")] private static extern bool IsZoomed(IntPtr hWnd);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);
        [DllImport("user32.dll")] private static extern int GetWindowTextLength(IntPtr hWnd);
        [DllImport("user32.dll")] private static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
        [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
        [DllImport("user32.dll")] private static extern IntPtr GetForegroundWindow();
        [DllImport("user32.dll")] private static extern bool SetForegroundWindow(IntPtr hWnd);
        [DllImport("user32.dll")] private static extern bool BringWindowToTop(IntPtr hWnd);
        [DllImport("user32.dll")] private static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
        [DllImport("user32.dll")] private static extern bool MoveWindow(IntPtr hWnd, int X, int Y, int nWidth, int nHeight, bool bRepaint);
        [DllImport("user32.dll")] private static extern bool PostMessage(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam);
        [DllImport("user32.dll")] private static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);
        [DllImport("kernel32.dll")] private static extern uint GetCurrentThreadId();
        [DllImport("user32.dll")] private static extern bool SetCursorPos(int X, int Y);
        [DllImport("user32.dll")] private static extern bool GetCursorPos(out POINT lpPoint);
        [DllImport("user32.dll", SetLastError = true)] private static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);

        private const uint WM_CLOSE = 0x0010;
        private const int SW_RESTORE = 9;
        private const int SW_MINIMIZE = 6;
        private const int SW_MAXIMIZE = 3;

        private const uint INPUT_MOUSE = 0;
        private const uint INPUT_KEYBOARD = 1;
        private const uint MOUSEEVENTF_LEFTDOWN = 0x0002;
        private const uint MOUSEEVENTF_LEFTUP = 0x0004;
        private const uint MOUSEEVENTF_RIGHTDOWN = 0x0008;
        private const uint MOUSEEVENTF_RIGHTUP = 0x0010;
        private const uint MOUSEEVENTF_MIDDLEDOWN = 0x0020;
        private const uint MOUSEEVENTF_MIDDLEUP = 0x0040;
        private const uint MOUSEEVENTF_WHEEL = 0x0800;
        private const uint MOUSEEVENTF_HWHEEL = 0x01000;

        private const uint KEYEVENTF_EXTENDEDKEY = 0x0001;
        private const uint KEYEVENTF_KEYUP = 0x0002;
        private const uint KEYEVENTF_UNICODE = 0x0004;

        [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
        [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }

        [StructLayout(LayoutKind.Sequential)]
        private struct INPUT {
            public uint type;
            public InputUnion U;
        }
        [StructLayout(LayoutKind.Explicit)]
        private struct InputUnion {
            [FieldOffset(0)] public MOUSEINPUT mi;
            [FieldOffset(0)] public KEYBDINPUT ki;
            [FieldOffset(0)] public HARDWAREINPUT hi;
        }
        [StructLayout(LayoutKind.Sequential)]
        private struct MOUSEINPUT {
            public int dx, dy;
            public uint mouseData, dwFlags, time;
            public IntPtr dwExtraInfo;
        }
        [StructLayout(LayoutKind.Sequential)]
        private struct KEYBDINPUT {
            public ushort wVk, wScan;
            public uint dwFlags, time;
            public IntPtr dwExtraInfo;
        }
        [StructLayout(LayoutKind.Sequential)]
        private struct HARDWAREINPUT {
            public uint uMsg;
            public ushort wParamL, wParamH;
        }

        public static void InitDpi() {
            try { SetProcessDpiAwarenessContext(new IntPtr(-4)); }
            catch { try { SetProcessDPIAware(); } catch { } }
        }

        public static bool FixedTimeEquals(string a, string b) {
            if (a == null || b == null) return false;
            byte[] ba = Encoding.UTF8.GetBytes(a);
            byte[] bb = Encoding.UTF8.GetBytes(b);
            int diff = ba.Length ^ bb.Length;
            int min = Math.Min(ba.Length, bb.Length);
            for (int i = 0; i < min; i++) diff |= ba[i] ^ bb[i];
            return diff == 0;
        }

        public static Dictionary<string, object> GetCursor() {
            POINT p;
            GetCursorPos(out p);
            var d = new Dictionary<string, object>();
            d["x"] = p.X;
            d["y"] = p.Y;
            return d;
        }

        public static List<Dictionary<string, object>> ListMonitors() {
            var list = new List<Dictionary<string, object>>();
            int idx = 0;
            foreach (Screen s in Screen.AllScreens) {
                var item = new Dictionary<string, object>();
                item["index"] = idx++;
                item["deviceName"] = s.DeviceName;
                item["primary"] = s.Primary;
                item["x"] = s.Bounds.X;
                item["y"] = s.Bounds.Y;
                item["width"] = s.Bounds.Width;
                item["height"] = s.Bounds.Height;
                list.Add(item);
            }
            return list;
        }

        public static List<Dictionary<string, object>> ListWindows() {
            var list = new List<Dictionary<string, object>>();
            IntPtr fg = GetForegroundWindow();
            EnumWindows(delegate(IntPtr hWnd, IntPtr lParam) {
                if (!IsWindowVisible(hWnd)) return true;
                int len = GetWindowTextLength(hWnd);
                if (len <= 0) return true;
                var sb = new StringBuilder(len + 1);
                GetWindowText(hWnd, sb, sb.Capacity);
                string title = sb.ToString().Trim();
                if (string.IsNullOrEmpty(title)) return true;
                RECT r;
                if (!GetWindowRect(hWnd, out r)) return true;
                int w = r.Right - r.Left;
                int h = r.Bottom - r.Top;
                if (w <= 0 || h <= 0) return true;
                uint pid = 0;
                GetWindowThreadProcessId(hWnd, out pid);
                string procName = "";
                try { procName = Process.GetProcessById((int)pid).ProcessName; } catch { }
                var item = new Dictionary<string, object>();
                item["hwnd"] = hWnd.ToInt64().ToString();
                item["pid"] = (int)pid;
                item["process"] = procName;
                item["title"] = title;
                item["focused"] = (hWnd == fg);
                item["minimized"] = IsIconic(hWnd);
                item["maximized"] = IsZoomed(hWnd);
                var bounds = new Dictionary<string, object>();
                bounds["x"] = r.Left; bounds["y"] = r.Top; bounds["width"] = w; bounds["height"] = h;
                item["bounds"] = bounds;
                list.Add(item);
                return true;
            }, IntPtr.Zero);
            return list;
        }

        public static long GetForegroundHwnd() {
            return GetForegroundWindow().ToInt64();
        }

        public static bool WindowAction(long hwndVal, string action, int x, int y, int w, int h) {
            IntPtr hWnd = new IntPtr(hwndVal);
            if (action == "focus") {
                if (IsIconic(hWnd)) ShowWindow(hWnd, SW_RESTORE);
                IntPtr fg = GetForegroundWindow();
                uint fgPid;
                uint fgThread = GetWindowThreadProcessId(fg, out fgPid);
                uint curThread = GetCurrentThreadId();
                if (fgThread != curThread && fgThread != 0) AttachThreadInput(curThread, fgThread, true);
                BringWindowToTop(hWnd);
                SetForegroundWindow(hWnd);
                if (fgThread != curThread && fgThread != 0) AttachThreadInput(curThread, fgThread, false);
                return true;
            }
            if (action == "minimize") return ShowWindow(hWnd, SW_MINIMIZE);
            if (action == "maximize") return ShowWindow(hWnd, SW_MAXIMIZE);
            if (action == "restore") return ShowWindow(hWnd, SW_RESTORE);
            if (action == "close") return PostMessage(hWnd, WM_CLOSE, IntPtr.Zero, IntPtr.Zero);
            if (action == "move_resize") return MoveWindow(hWnd, x, y, w, h, true);
            return false;
        }

        public static Dictionary<string, object> CaptureScreen(int monitorIndex, long hwndVal, int maxWidth, int quality, bool drawCursor) {
            Rectangle rect;
            if (hwndVal != 0) {
                RECT r;
                if (!GetWindowRect(new IntPtr(hwndVal), out r)) throw new Exception("Window not found.");
                rect = new Rectangle(r.Left, r.Top, Math.Max(1, r.Right - r.Left), Math.Max(1, r.Bottom - r.Top));
            } else if (monitorIndex >= 0 && monitorIndex < Screen.AllScreens.Length) {
                rect = Screen.AllScreens[monitorIndex].Bounds;
            } else {
                rect = SystemInformation.VirtualScreen;
            }

            using (Bitmap raw = new Bitmap(rect.Width, rect.Height, PixelFormat.Format24bppRgb)) {
                using (Graphics g = Graphics.FromImage(raw)) {
                    g.CopyFromScreen(rect.Left, rect.Top, 0, 0, rect.Size, CopyPixelOperation.SourceCopy);
                    if (drawCursor) {
                        POINT cp;
                        if (GetCursorPos(out cp)) {
                            int cx = cp.X - rect.Left;
                            int cy = cp.Y - rect.Top;
                            if (cx >= 0 && cy >= 0 && cx < rect.Width && cy < rect.Height) {
                                g.SmoothingMode = SmoothingMode.AntiAlias;
                                using (Pen p = new Pen(Color.Red, 3f)) g.DrawEllipse(p, cx - 8, cy - 8, 16, 16);
                                using (Brush b = new SolidBrush(Color.Yellow)) g.FillEllipse(b, cx - 3, cy - 3, 6, 6);
                            }
                        }
                    }
                }

                int outW = rect.Width;
                int outH = rect.Height;
                if (maxWidth > 0 && rect.Width > maxWidth) {
                    outW = maxWidth;
                    outH = (int)Math.Round((double)rect.Height * maxWidth / rect.Width);
                }

                Bitmap target = raw;
                Bitmap resized = null;
                try {
                    if (outW != rect.Width || outH != rect.Height) {
                        resized = new Bitmap(outW, outH, PixelFormat.Format24bppRgb);
                        using (Graphics rg = Graphics.FromImage(resized)) {
                            rg.InterpolationMode = InterpolationMode.HighQualityBicubic;
                            rg.DrawImage(raw, 0, 0, outW, outH);
                        }
                        target = resized;
                    }
                    ImageCodecInfo jpg = null;
                    foreach (ImageCodecInfo c in ImageCodecInfo.GetImageEncoders()) {
                        if (c.MimeType == "image/jpeg") { jpg = c; break; }
                    }
                    using (MemoryStream ms = new MemoryStream()) {
                        if (jpg != null) {
                            EncoderParameters ep = new EncoderParameters(1);
                            ep.Param[0] = new EncoderParameter(System.Drawing.Imaging.Encoder.Quality, (long)Math.Max(30, Math.Min(95, quality)));
                            target.Save(ms, jpg, ep);
                        } else {
                            target.Save(ms, ImageFormat.Jpeg);
                        }
                        POINT cur;
                        GetCursorPos(out cur);
                        var res = new Dictionary<string, object>();
                        res["originX"] = rect.Left;
                        res["originY"] = rect.Top;
                        res["screenWidth"] = rect.Width;
                        res["screenHeight"] = rect.Height;
                        res["imageWidth"] = outW;
                        res["imageHeight"] = outH;
                        res["scaleX"] = (double)rect.Width / outW;
                        res["scaleY"] = (double)rect.Height / outH;
                        res["cursorX"] = cur.X;
                        res["cursorY"] = cur.Y;
                        res["mimeType"] = "image/jpeg";
                        res["screenshotBase64"] = Convert.ToBase64String(ms.ToArray());
                        return res;
                    }
                } finally {
                    if (resized != null) resized.Dispose();
                }
            }
        }

        public static List<Dictionary<string, object>> GetUiaTree(long hwndVal, int maxElements, int maxDepth) {
            var results = new List<Dictionary<string, object>>();
            IntPtr hWnd = hwndVal != 0 ? new IntPtr(hwndVal) : GetForegroundWindow();
            if (hWnd == IntPtr.Zero) return results;
            AutomationElement root = null;
            try { root = AutomationElement.FromHandle(hWnd); } catch { return results; }
            if (root == null) return results;

            var queue = new Queue<KeyValuePair<AutomationElement, int>>();
            queue.Enqueue(new KeyValuePair<AutomationElement, int>(root, 0));
            TreeWalker walker = TreeWalker.ControlViewWalker;
            int idCounter = 0;
            Stopwatch sw = Stopwatch.StartNew();

            while (queue.Count > 0 && results.Count < maxElements && sw.ElapsedMilliseconds < 2500) {
                var pair = queue.Dequeue();
                AutomationElement el = pair.Key;
                int depth = pair.Value;
                try {
                    var c = el.Current;
                    var br = c.BoundingRectangle;
                    bool hasRect = !br.IsEmpty && !double.IsInfinity(br.Width) && !double.IsInfinity(br.Height) && br.Width >= 2 && br.Height >= 2;
                    string role = c.ControlType != null ? c.ControlType.ProgrammaticName.Replace("ControlType.", "") : "Unknown";
                    string name = c.Name ?? "";
                    string autoId = c.AutomationId ?? "";
                    string val = "";
                    try {
                        object pat;
                        if (el.TryGetCurrentPattern(ValuePattern.Pattern, out pat)) {
                            val = ((ValuePattern)pat).Current.Value ?? "";
                            if (val.Length > 200) val = val.Substring(0, 200);
                        }
                    } catch { }

                    bool interesting = hasRect && !c.IsOffscreen && (
                        role == "Button" || role == "Edit" || role == "CheckBox" || role == "RadioButton" ||
                        role == "ComboBox" || role == "ListItem" || role == "MenuItem" || role == "TabItem" ||
                        role == "Hyperlink" || role == "Document" || role == "TreeItem" || role == "Slider" ||
                        (!string.IsNullOrEmpty(name) && (role == "Text" || role == "Window" || role == "Pane" || role == "DataItem"))
                    );

                    if (interesting) {
                        idCounter++;
                        int rx = (int)Math.Round(br.Left);
                        int ry = (int)Math.Round(br.Top);
                        int rw = (int)Math.Round(br.Width);
                        int rh = (int)Math.Round(br.Height);
                        var node = new Dictionary<string, object>();
                        node["id"] = "e" + idCounter;
                        node["role"] = role;
                        node["name"] = name.Length > 160 ? name.Substring(0, 160) : name;
                        if (!string.IsNullOrEmpty(autoId)) node["automationId"] = autoId;
                        if (!string.IsNullOrEmpty(val)) node["value"] = val;
                        node["enabled"] = c.IsEnabled;
                        node["focused"] = c.HasKeyboardFocus;
                        var b = new Dictionary<string, object>();
                        b["x"] = rx; b["y"] = ry; b["width"] = rw; b["height"] = rh;
                        node["bounds"] = b;
                        var ctr = new Dictionary<string, object>();
                        ctr["x"] = rx + rw / 2; ctr["y"] = ry + rh / 2;
                        node["center"] = ctr;
                        results.Add(node);
                    }

                    if (depth < maxDepth) {
                        AutomationElement child = walker.GetFirstChild(el);
                        int siblings = 0;
                        while (child != null && siblings < 80 && sw.ElapsedMilliseconds < 2500) {
                            queue.Enqueue(new KeyValuePair<AutomationElement, int>(child, depth + 1));
                            child = walker.GetNextSibling(child);
                            siblings++;
                        }
                    }
                } catch { }
            }
            return results;
        }

        public static void MoveMouse(int x, int y) {
            SetCursorPos(x, y);
        }

        private static void SendMouseFlag(uint flag, uint data) {
            INPUT[] inp = new INPUT[1];
            inp[0].type = INPUT_MOUSE;
            inp[0].U.mi.dwFlags = flag;
            inp[0].U.mi.mouseData = data;
            SendInput(1, inp, Marshal.SizeOf(typeof(INPUT)));
        }

        public static void Click(int x, int y, string button, int clicks, string[] modifiers) {
            List<ushort> modVks = new List<ushort>();
            if (modifiers != null) {
                foreach (string m in modifiers) {
                    ushort vk = MapKey(m);
                    if (vk != 0) { modVks.Add(vk); SendVk(vk, false); }
                }
            }
            SetCursorPos(x, y);
            Thread.Sleep(25);
            uint down = MOUSEEVENTF_LEFTDOWN, up = MOUSEEVENTF_LEFTUP;
            if (button == "right") { down = MOUSEEVENTF_RIGHTDOWN; up = MOUSEEVENTF_RIGHTUP; }
            else if (button == "middle") { down = MOUSEEVENTF_MIDDLEDOWN; up = MOUSEEVENTF_MIDDLEUP; }
            int count = Math.Max(1, Math.Min(3, clicks));
            for (int i = 0; i < count; i++) {
                SendMouseFlag(down, 0);
                Thread.Sleep(20);
                SendMouseFlag(up, 0);
                if (i + 1 < count) Thread.Sleep(45);
            }
            for (int i = modVks.Count - 1; i >= 0; i--) SendVk(modVks[i], true);
        }

        public static void Drag(int x1, int y1, int x2, int y2, string button, int steps) {
            uint down = button == "right" ? MOUSEEVENTF_RIGHTDOWN : MOUSEEVENTF_LEFTDOWN;
            uint up = button == "right" ? MOUSEEVENTF_RIGHTUP : MOUSEEVENTF_LEFTUP;
            SetCursorPos(x1, y1);
            Thread.Sleep(30);
            SendMouseFlag(down, 0);
            Thread.Sleep(30);
            int n = Math.Max(5, Math.Min(60, steps));
            for (int i = 1; i <= n; i++) {
                int ix = x1 + (int)Math.Round((double)(x2 - x1) * i / n);
                int iy = y1 + (int)Math.Round((double)(y2 - y1) * i / n);
                SetCursorPos(ix, iy);
                Thread.Sleep(12);
            }
            SendMouseFlag(up, 0);
        }

        public static void Scroll(int deltaY, int deltaX, bool hasPos, int x, int y) {
            if (hasPos) { SetCursorPos(x, y); Thread.Sleep(20); }
            if (deltaY != 0) SendMouseFlag(MOUSEEVENTF_WHEEL, unchecked((uint)(deltaY * 120)));
            if (deltaX != 0) SendMouseFlag(MOUSEEVENTF_HWHEEL, unchecked((uint)(deltaX * 120)));
        }

        public static void TypeText(string text, bool pressEnter) {
            if (!string.IsNullOrEmpty(text)) {
                foreach (char ch in text) {
                    if (ch == '\r') continue;
                    if (ch == '\n') { PressCombo("Enter"); continue; }
                    INPUT[] inp = new INPUT[2];
                    inp[0].type = INPUT_KEYBOARD;
                    inp[0].U.ki.wScan = (ushort)ch;
                    inp[0].U.ki.dwFlags = KEYEVENTF_UNICODE;
                    inp[1].type = INPUT_KEYBOARD;
                    inp[1].U.ki.wScan = (ushort)ch;
                    inp[1].U.ki.dwFlags = KEYEVENTF_UNICODE | KEYEVENTF_KEYUP;
                    SendInput(2, inp, Marshal.SizeOf(typeof(INPUT)));
                    Thread.Sleep(4);
                }
            }
            if (pressEnter) PressCombo("Enter");
        }

        private static bool IsExtended(ushort vk) {
            return vk == 0x21 || vk == 0x22 || vk == 0x23 || vk == 0x24 || vk == 0x25 || vk == 0x26 ||
                   vk == 0x27 || vk == 0x28 || vk == 0x2D || vk == 0x2E || vk == 0x5B || vk == 0x5C;
        }

        private static void SendVk(ushort vk, bool keyUp) {
            INPUT[] inp = new INPUT[1];
            inp[0].type = INPUT_KEYBOARD;
            inp[0].U.ki.wVk = vk;
            inp[0].U.ki.dwFlags = (keyUp ? KEYEVENTF_KEYUP : 0u) | (IsExtended(vk) ? KEYEVENTF_EXTENDEDKEY : 0u);
            SendInput(1, inp, Marshal.SizeOf(typeof(INPUT)));
        }

        public static ushort MapKey(string key) {
            if (string.IsNullOrEmpty(key)) return 0;
            string k = key.Trim().ToLowerInvariant();
            switch (k) {
                case "ctrl": case "control": return 0x11;
                case "shift": return 0x10;
                case "alt": case "option": return 0x12;
                case "win": case "meta": case "cmd": case "super": case "windows": return 0x5B;
                case "enter": case "return": return 0x0D;
                case "esc": case "escape": return 0x1B;
                case "tab": return 0x09;
                case "space": return 0x20;
                case "backspace": case "bs": return 0x08;
                case "delete": case "del": return 0x2E;
                case "insert": case "ins": return 0x2D;
                case "home": return 0x24;
                case "end": return 0x23;
                case "pageup": case "pgup": return 0x21;
                case "pagedown": case "pgdn": return 0x22;
                case "up": case "arrowup": return 0x26;
                case "down": case "arrowdown": return 0x28;
                case "left": case "arrowleft": return 0x25;
                case "right": case "arrowright": return 0x27;
                case "printscreen": case "prtsc": return 0x2C;
                case "capslock": return 0x14;
                case "f1": return 0x70; case "f2": return 0x71; case "f3": return 0x72; case "f4": return 0x73;
                case "f5": return 0x74; case "f6": return 0x75; case "f7": return 0x76; case "f8": return 0x77;
                case "f9": return 0x78; case "f10": return 0x79; case "f11": return 0x7A; case "f12": return 0x7B;
                case "-": case "minus": return 0xBD;
                case "=": case "equal": case "plus": return 0xBB;
                case "[": return 0xDB; case "]": return 0xDD; case "\\": return 0xDC;
                case ";": return 0xBA; case "'": return 0xDE; case ",": return 0xBC;
                case ".": return 0xBE; case "/": return 0xBF; case "\x60": return 0xC0;
            }
            if (k.Length == 1) {
                char c = char.ToUpperInvariant(k[0]);
                if ((c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9')) return (ushort)c;
            }
            return 0;
        }

        public static void PressCombo(string combo) {
            if (string.IsNullOrEmpty(combo)) return;
            string[] parts = combo.Split('+');
            List<ushort> vks = new List<ushort>();
            foreach (string part in parts) {
                ushort vk = MapKey(part);
                if (vk != 0) vks.Add(vk);
            }
            if (vks.Count == 0) throw new Exception("Unknown key: " + combo);
            for (int i = 0; i < vks.Count; i++) { SendVk(vks[i], false); Thread.Sleep(15); }
            Thread.Sleep(25);
            for (int i = vks.Count - 1; i >= 0; i--) { SendVk(vks[i], true); Thread.Sleep(15); }
        }

        public static string ClipboardGet() {
            string result = "";
            Exception err = null;
            Thread t = new Thread(delegate() {
                try { if (Clipboard.ContainsText()) result = Clipboard.GetText(); }
                catch (Exception ex) { err = ex; }
            });
            t.SetApartmentState(ApartmentState.STA);
            t.Start();
            t.Join(3000);
            if (err != null) throw err;
            return result;
        }

        public static void ClipboardSet(string text) {
            Exception err = null;
            Thread t = new Thread(delegate() {
                try { Clipboard.SetText(text ?? ""); }
                catch (Exception ex) { err = ex; }
            });
            t.SetApartmentState(ApartmentState.STA);
            t.Start();
            t.Join(3000);
            if (err != null) throw err;
        }
    }
}
'@

Add-Type -TypeDefinition $nativeSource -ReferencedAssemblies @(
  'System.Drawing',
  'System.Windows.Forms',
  'UIAutomationClient',
  'UIAutomationTypes',
  'WindowsBase'
)
[DevDashPc.Native]::InitDpi()

function Resolve-TargetPoint($body) {
  if ($body.elementId -and $script:ElementMap.ContainsKey([string]$body.elementId)) {
    $el = $script:ElementMap[[string]$body.elementId]
    return @{ x = [int]$el.center.x; y = [int]$el.center.y }
  }
  if ($null -eq $body.x -or $null -eq $body.y) {
    throw "Provide either (x, y) coordinates or a valid elementId from get_window_state."
  }
  return @{ x = [int]$body.x; y = [int]$body.y }
}

function Invoke-PcAction([string]$method, [string]$path, $body) {
  if ($path -eq '/health' -and $method -eq 'GET') {
    $liveTs = Get-LiveTailscaleIp
    return @{
      ok = $true
      hostname = $env:COMPUTERNAME
      user = $env:USERNAME
      os = [System.Environment]::OSVersion.VersionString
      tailscaleIp = $liveTs
      tailscaleConnected = ($null -ne $liveTs)
      paused = $script:Paused
      allowShell = $script:AllowShell
      monitors = [DevDashPc.Native]::ListMonitors()
      cursor = [DevDashPc.Native]::GetCursor()
      version = '1.0.0'
    }
  }

  if ($script:Paused) {
    throw "PC control is currently PAUSED on $($env:COMPUTERNAME). Resume it from the system tray."
  }

  $liveIp = Get-LiveTailscaleIp
  if (-not $liveIp) {
    throw "Tailscale is disconnected on $($env:COMPUTERNAME)."
  }

  switch ($path) {
    '/v1/monitors' {
      return @{ ok = $true; monitors = [DevDashPc.Native]::ListMonitors() }
    }
    '/v1/apps' {
      $procs = Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -or $_.WS -gt 30MB } |
        Sort-Object -Property WorkingSet64 -Descending | Select-Object -First 60 |
        ForEach-Object {
          $pPath = $null
          try { $pPath = $_.Path } catch {}
          @{
            pid = $_.Id
            name = $_.ProcessName
            title = $_.MainWindowTitle
            path = $pPath
            memoryMB = [math]::Round($_.WorkingSet64 / 1MB, 1)
          }
        }
      return @{ ok = $true; apps = @($procs) }
    }
    '/v1/windows' {
      return @{ ok = $true; windows = [DevDashPc.Native]::ListWindows() }
    }
    '/v1/window_state' {
      $hwnd = if ($body -and $body.hwnd) { [long]$body.hwnd } else { [DevDashPc.Native]::GetForegroundHwnd() }
      $includeScreenshot = if ($body -and $null -ne $body.includeScreenshot) { [bool]$body.includeScreenshot } else { $true }
      $maxWidth = if ($body -and $body.maxWidth) { [int]$body.maxWidth } else { 1280 }
      $quality = if ($body -and $body.quality) { [int]$body.quality } else { 72 }
      $maxElements = if ($body -and $body.maxElements) { [int]$body.maxElements } else { 140 }
      $fullScreen = if ($body -and $body.fullScreen) { [bool]$body.fullScreen } else { $false }

      $windows = [DevDashPc.Native]::ListWindows()
      $win = $windows | Where-Object { $_.hwnd -eq $hwnd.ToString() } | Select-Object -First 1
      $elements = [DevDashPc.Native]::GetUiaTree($hwnd, $maxElements, 10)
      $script:ElementMap = @{}
      foreach ($el in $elements) { $script:ElementMap[[string]$el.id] = $el }

      $res = @{
        ok = $true
        window = $win
        elements = $elements
        elementCount = $elements.Count
      }
      if ($includeScreenshot) {
        $capHwnd = if ($fullScreen) { 0L } else { $hwnd }
        $shot = [DevDashPc.Native]::CaptureScreen(-1, $capHwnd, $maxWidth, $quality, $true)
        foreach ($k in $shot.Keys) { $res[$k] = $shot[$k] }
      }
      return $res
    }
    '/v1/screenshot' {
      $mon = if ($body -and $null -ne $body.monitor) { [int]$body.monitor } else { -1 }
      $hwnd = if ($body -and $body.hwnd) { [long]$body.hwnd } else { 0L }
      $maxWidth = if ($body -and $body.maxWidth) { [int]$body.maxWidth } else { 1280 }
      $quality = if ($body -and $body.quality) { [int]$body.quality } else { 72 }
      $drawCursor = if ($body -and $null -ne $body.drawCursor) { [bool]$body.drawCursor } else { $true }
      $shot = [DevDashPc.Native]::CaptureScreen($mon, $hwnd, $maxWidth, $quality, $drawCursor)
      $shot['ok'] = $true
      return $shot
    }
    '/v1/window_action' {
      $hwnd = if ($body.hwnd) { [long]$body.hwnd } else { 0L }
      if ($hwnd -eq 0 -and $body.title) {
        $match = [DevDashPc.Native]::ListWindows() | Where-Object { $_.title -like "*$($body.title)*" -or $_.process -like "*$($body.title)*" } | Select-Object -First 1
        if ($match) { $hwnd = [long]$match.hwnd }
      }
      if ($hwnd -eq 0) { throw "Window not found." }
      $action = [string]$body.action
      $ok = [DevDashPc.Native]::WindowAction($hwnd, $action, [int]$body.x, [int]$body.y, [int]$body.width, [int]$body.height)
      return @{ ok = $ok; hwnd = $hwnd.ToString(); action = $action }
    }
    '/v1/launch_app' {
      $target = [string]$body.target
      if (-not $target) { throw "Missing target." }
      $psi = New-Object System.Diagnostics.ProcessStartInfo
      $psi.FileName = $target
      if ($body.args) { $psi.Arguments = [string]$body.args }
      if ($body.cwd) { $psi.WorkingDirectory = [string]$body.cwd }
      $psi.UseShellExecute = $true
      $proc = [System.Diagnostics.Process]::Start($psi)
      return @{ ok = $true; target = $target; pid = if ($proc) { $proc.Id } else { $null } }
    }
    '/v1/kill_app' {
      if ($body.pid) {
        Stop-Process -Id ([int]$body.pid) -Force
        return @{ ok = $true; pid = [int]$body.pid }
      }
      if ($body.name) {
        Stop-Process -Name ([string]$body.name) -Force
        return @{ ok = $true; name = [string]$body.name }
      }
      throw "Provide pid or name."
    }
    '/v1/click' {
      $pt = Resolve-TargetPoint $body
      $btn = if ($body.button) { [string]$body.button } else { 'left' }
      $clicks = if ($body.clicks) { [int]$body.clicks } else { 1 }
      $mods = if ($body.modifiers) { [string[]]@($body.modifiers) } else { $null }
      [DevDashPc.Native]::Click($pt.x, $pt.y, $btn, $clicks, $mods)
      return @{ ok = $true; x = $pt.x; y = $pt.y; button = $btn; clicks = $clicks }
    }
    '/v1/move_mouse' {
      $pt = Resolve-TargetPoint $body
      [DevDashPc.Native]::MoveMouse($pt.x, $pt.y)
      return @{ ok = $true; x = $pt.x; y = $pt.y }
    }
    '/v1/drag' {
      $btn = if ($body.button) { [string]$body.button } else { 'left' }
      $steps = if ($body.steps) { [int]$body.steps } else { 20 }
      [DevDashPc.Native]::Drag([int]$body.x1, [int]$body.y1, [int]$body.x2, [int]$body.y2, $btn, $steps)
      return @{ ok = $true }
    }
    '/v1/scroll' {
      $hasPos = ($null -ne $body.x -and $null -ne $body.y)
      $dy = if ($null -ne $body.deltaY) { [int]$body.deltaY } else { -3 }
      $dx = if ($null -ne $body.deltaX) { [int]$body.deltaX } else { 0 }
      [DevDashPc.Native]::Scroll($dy, $dx, $hasPos, [int]$body.x, [int]$body.y)
      return @{ ok = $true; deltaY = $dy; deltaX = $dx }
    }
    '/v1/type_text' {
      if ($body.elementId -and $script:ElementMap.ContainsKey([string]$body.elementId)) {
        $el = $script:ElementMap[[string]$body.elementId]
        [DevDashPc.Native]::Click([int]$el.center.x, [int]$el.center.y, 'left', 1, $null)
        Start-Sleep -Milliseconds 60
      }
      [DevDashPc.Native]::TypeText([string]$body.text, [bool]$body.enter)
      return @{ ok = $true; length = ([string]$body.text).Length }
    }
    '/v1/set_value' {
      $pt = Resolve-TargetPoint $body
      [DevDashPc.Native]::Click($pt.x, $pt.y, 'left', 1, $null)
      Start-Sleep -Milliseconds 60
      [DevDashPc.Native]::PressCombo('Ctrl+A')
      Start-Sleep -Milliseconds 40
      [DevDashPc.Native]::TypeText([string]$body.value, [bool]$body.enter)
      return @{ ok = $true; x = $pt.x; y = $pt.y }
    }
    '/v1/press_key' {
      [DevDashPc.Native]::PressCombo([string]$body.key)
      return @{ ok = $true; key = [string]$body.key }
    }
    '/v1/clipboard' {
      if ($body.mode -eq 'set') {
        [DevDashPc.Native]::ClipboardSet([string]$body.text)
        return @{ ok = $true; mode = 'set' }
      }
      return @{ ok = $true; mode = 'get'; text = [DevDashPc.Native]::ClipboardGet() }
    }
    '/v1/powershell' {
      if (-not $script:AllowShell) {
        throw "PowerShell execution is disabled on $($env:COMPUTERNAME). Enable it in DevDash or the tray menu."
      }
      $cmd = [string]$body.command
      if (-not $cmd) { throw "Missing command." }
      $timeoutSec = if ($body.timeoutSec) { [math]::Min([math]::Max([int]$body.timeoutSec, 2), 90) } else { 30 }
      $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($cmd))
      $psi = New-Object System.Diagnostics.ProcessStartInfo
      $psi.FileName = 'powershell.exe'
      $psi.Arguments = "-NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand $encoded"
      if ($body.cwd -and (Test-Path ([string]$body.cwd))) { $psi.WorkingDirectory = [string]$body.cwd }
      $psi.RedirectStandardOutput = $true
      $psi.RedirectStandardError = $true
      $psi.UseShellExecute = $false
      $psi.CreateNoWindow = $true
      $p = New-Object System.Diagnostics.Process
      $p.StartInfo = $psi
      [void]$p.Start()
      $outTask = $p.StandardOutput.ReadToEndAsync()
      $errTask = $p.StandardError.ReadToEndAsync()
      $exited = $p.WaitForExit($timeoutSec * 1000)
      if (-not $exited) {
        try { $p.Kill() } catch {}
        throw "PowerShell command timed out after ${timeoutSec}s."
      }
      $stdout = $outTask.Result
      $stderr = $errTask.Result
      if ($stdout.Length -gt 65536) { $stdout = $stdout.Substring(0, 65536) + "`n...[truncated]" }
      if ($stderr.Length -gt 32768) { $stderr = $stderr.Substring(0, 32768) + "`n...[truncated]" }
      return @{ ok = ($p.ExitCode -eq 0); exitCode = $p.ExitCode; stdout = $stdout; stderr = $stderr }
    }
    '/v1/fs' {
      $mode = [string]$body.mode
      $target = [string]$body.path
      if (-not $target) { throw "Missing path." }
      if ($mode -eq 'list') {
        $items = Get-ChildItem -LiteralPath $target -Force | Select-Object -First 200 | ForEach-Object {
          @{
            name = $_.Name
            path = $_.FullName
            isDir = $_.PSIsContainer
            size = if ($_.PSIsContainer) { 0 } else { $_.Length }
            modified = $_.LastWriteTimeUtc.ToString('o')
          }
        }
        return @{ ok = $true; path = $target; entries = @($items) }
      }
      if ($mode -eq 'read') {
        $maxBytes = if ($body.maxBytes) { [math]::Min([int]$body.maxBytes, 524288) } else { 131072 }
        $bytes = [System.IO.File]::ReadAllBytes($target)
        $truncated = $bytes.Length -gt $maxBytes
        $slice = if ($truncated) { $bytes[0..($maxBytes - 1)] } else { $bytes }
        return @{
          ok = $true
          path = $target
          size = $bytes.Length
          truncated = $truncated
          content = [Text.Encoding]::UTF8.GetString($slice)
        }
      }
      if ($mode -eq 'write') {
        $dir = Split-Path -Parent $target
        if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
        [System.IO.File]::WriteAllText($target, [string]$body.content, (New-Object System.Text.UTF8Encoding($false)))
        return @{ ok = $true; path = $target; bytes = ([Text.Encoding]::UTF8.GetByteCount([string]$body.content)) }
      }
      throw "Unknown fs mode: $mode"
    }
    default {
      throw "Unknown endpoint: $path"
    }
  }
}

function Send-HttpJson($stream, [int]$statusCode, [string]$statusText, $obj) {
  $json = ($obj | ConvertTo-Json -Depth 12 -Compress)
  $bodyBytes = [Text.Encoding]::UTF8.GetBytes($json)
  $header = "HTTP/1.1 $statusCode $statusText`r`nContent-Type: application/json; charset=utf-8`r`nContent-Length: $($bodyBytes.Length)`r`nConnection: close`r`n`r`n"
  $headBytes = [Text.Encoding]::ASCII.GetBytes($header)
  $stream.Write($headBytes, 0, $headBytes.Length)
  $stream.Write($bodyBytes, 0, $bodyBytes.Length)
  $stream.Flush()
}

function Handle-Client($client) {
  try {
    $client.ReceiveTimeout = 15000
    $client.SendTimeout = 30000
    $remoteIp = ([System.Net.IPEndPoint]$client.Client.RemoteEndPoint).Address.IPAddressToString
    $stream = $client.GetStream()
    if ($script:AllowedPeerIp -and $remoteIp -ne $script:AllowedPeerIp) {
      Write-AgentLog "REJECTED unauthorized remote IP: $remoteIp"
      Send-HttpJson $stream 403 'Forbidden' @{ ok = $false; error = 'Unauthorized peer IP.' }
      return
    }

    # Read HTTP headers up to \r\n\r\n
    $ms = New-Object System.IO.MemoryStream
    $buf = New-Object byte[] 8192
    $headerEnd = -1
    while ($headerEnd -lt 0 -and $ms.Length -lt 65536) {
      $n = $stream.Read($buf, 0, $buf.Length)
      if ($n -le 0) { break }
      $ms.Write($buf, 0, $n)
      $rawStr = [Text.Encoding]::GetEncoding('ISO-8859-1').GetString($ms.ToArray())
      $headerEnd = $rawStr.IndexOf("`r`n`r`n")
    }
    if ($headerEnd -lt 0) { return }
    $allBytes = $ms.ToArray()
    $headText = [Text.Encoding]::GetEncoding('ISO-8859-1').GetString($allBytes, 0, $headerEnd)
    $lines = $headText -split "`r`n"
    $reqParts = $lines[0] -split ' '
    $method = $reqParts[0].ToUpperInvariant()
    $path = ($reqParts[1] -split '\?')[0]
    $headers = @{}
    for ($i = 1; $i -lt $lines.Length; $i++) {
      $idx = $lines[$i].IndexOf(':')
      if ($idx -gt 0) {
        $headers[$lines[$i].Substring(0, $idx).Trim().ToLowerInvariant()] = $lines[$i].Substring($idx + 1).Trim()
      }
    }

    $authHeader = $headers['authorization']
    $expectedAuth = "Bearer $($script:Token)"
    if (-not [DevDashPc.Native]::FixedTimeEquals($authHeader, $expectedAuth)) {
      Write-AgentLog "REJECTED invalid bearer token from $remoteIp"
      Send-HttpJson $stream 401 'Unauthorized' @{ ok = $false; error = 'Invalid token.' }
      return
    }

    $contentLen = if ($headers.ContainsKey('content-length')) { [int]$headers['content-length'] } else { 0 }
    if ($contentLen -gt 8388608) {
      Send-HttpJson $stream 413 'Payload Too Large' @{ ok = $false; error = 'Request too large.' }
      return
    }
    $bodyStart = $headerEnd + 4
    $bodyMs = New-Object System.IO.MemoryStream
    if ($allBytes.Length -gt $bodyStart) {
      $bodyMs.Write($allBytes, $bodyStart, $allBytes.Length - $bodyStart)
    }
    while ($bodyMs.Length -lt $contentLen) {
      $need = [math]::Min($buf.Length, $contentLen - [int]$bodyMs.Length)
      $n = $stream.Read($buf, 0, $need)
      if ($n -le 0) { break }
      $bodyMs.Write($buf, 0, $n)
    }

    $bodyObj = $null
    if ($bodyMs.Length -gt 0) {
      $bodyText = [Text.Encoding]::UTF8.GetString($bodyMs.ToArray())
      $bodyObj = $bodyText | ConvertFrom-Json
    }

    $result = Invoke-PcAction $method $path $bodyObj
    Send-HttpJson $stream 200 'OK' $result
  } catch {
    $errMsg = $_.Exception.Message
    Write-AgentLog "ERROR $($path): $errMsg"
    try { Send-HttpJson $client.GetStream() 400 'Bad Request' @{ ok = $false; error = $errMsg } } catch {}
  } finally {
    try { $client.Close() } catch {}
  }
}

# Wait for Tailscale IP on startup
$bindIp = Get-LiveTailscaleIp
if (-not $bindIp) {
  Write-AgentLog "Tailscale is not connected yet. Waiting for Tailscale IPv4..."
  while (-not $bindIp -and $script:Running) {
    Start-Sleep -Seconds 3
    $bindIp = Get-LiveTailscaleIp
  }
}

$script:Listener = $null
function Start-TailscaleListener([string]$ip) {
  if ($script:Listener) { try { $script:Listener.Stop() } catch {} }
  $script:Listener = New-Object System.Net.Sockets.TcpListener([System.Net.IPAddress]::Parse($ip), $script:Port)
  $script:Listener.Start()
  Write-AgentLog "Listening strictly on Tailscale ${ip}:$($script:Port) (allowed peer: $($script:AllowedPeerIp))"
}

Start-TailscaleListener $bindIp
$script:BoundIp = $bindIp

# Optional Windows System Tray Kill-Switch
$tray = $null
if (-not $NoTray) {
  try {
    $tray = New-Object System.Windows.Forms.NotifyIcon
    $tray.Icon = [System.Drawing.SystemIcons]::Shield
    $tray.Text = "DevDash PC Agent (Active on $bindIp)"
    $tray.Visible = $true

    $menu = New-Object System.Windows.Forms.ContextMenuStrip
    $statusItem = $menu.Items.Add("Active ($bindIp`:$($script:Port))")
    $statusItem.Enabled = $false
    [void]$menu.Items.Add("-")
    $pauseItem = $menu.Items.Add("Pause AI Control (Kill-Switch)")
    $pauseItem.Add_Click({
      $script:Paused = -not $script:Paused
      if ($script:Paused) {
        $pauseItem.Text = "Resume AI Control"
        $statusItem.Text = "PAUSED (AI blocked)"
        $tray.Text = "DevDash PC Agent (PAUSED)"
        Write-AgentLog "PAUSED via system tray kill-switch"
      } else {
        $pauseItem.Text = "Pause AI Control (Kill-Switch)"
        $statusItem.Text = "Active ($($script:BoundIp):$($script:Port))"
        $tray.Text = "DevDash PC Agent (Active)"
        Write-AgentLog "RESUMED via system tray"
      }
    })
    $shellItem = $menu.Items.Add("PowerShell Access: $(if ($script:AllowShell) { 'ON' } else { 'OFF' })")
    $shellItem.Add_Click({
      $script:AllowShell = -not $script:AllowShell
      $shellItem.Text = "PowerShell Access: $(if ($script:AllowShell) { 'ON' } else { 'OFF' })"
      Write-AgentLog "PowerShell Access toggled: $($script:AllowShell)"
    })
    $logItem = $menu.Items.Add("Open Agent Folder")
    $logItem.Add_Click({ Start-Process explorer.exe $script:LogDir })
    [void]$menu.Items.Add("-")
    $exitItem = $menu.Items.Add("Stop DevDash PC Agent")
    $exitItem.Add_Click({
      Write-AgentLog "Stopping agent via system tray"
      $script:Running = $false
    })
    $tray.ContextMenuStrip = $menu
  } catch {
    Write-AgentLog "Tray init skipped: $($_.Exception.Message)"
  }
}

$lastWatchdog = [DateTime]::UtcNow
try {
  while ($script:Running) {
    if ($tray) { [System.Windows.Forms.Application]::DoEvents() }

    # Tailscale watchdog every 5s: close listener immediately if Tailscale disconnects!
    if (([DateTime]::UtcNow - $lastWatchdog).TotalSeconds -ge 5) {
      $lastWatchdog = [DateTime]::UtcNow
      $live = Get-LiveTailscaleIp
      if (-not $live) {
        if ($script:Listener) {
          Write-AgentLog "Tailscale disconnected! Stopping listener immediately."
          try { $script:Listener.Stop() } catch {}
          $script:Listener = $null
          $script:BoundIp = $null
          if ($tray) { $tray.Text = "DevDash PC Agent (Tailscale Offline)" }
        }
      } elseif ($live -ne $script:BoundIp -or -not $script:Listener) {
        Write-AgentLog "Tailscale connected on $live — starting listener."
        Start-TailscaleListener $live
        $script:BoundIp = $live
        if ($tray) { $tray.Text = "DevDash PC Agent (Active on $live)" }
      }
    }

    if ($script:Listener -and $script:Listener.Pending()) {
      $client = $script:Listener.AcceptTcpClient()
      Handle-Client $client
    } else {
      Start-Sleep -Milliseconds 35
    }
  }
} finally {
  if ($script:Listener) { try { $script:Listener.Stop() } catch {} }
  if ($tray) { $tray.Visible = $false; $tray.Dispose() }
  Write-AgentLog "Agent stopped."
}
