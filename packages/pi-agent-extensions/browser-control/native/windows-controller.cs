// .NET Framework 4.x / C# 5. No browser launch, CDP, profile access, or global input fallback.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Automation;

public static class WindowsBrowserController {
    delegate bool EnumProc(IntPtr hwnd, IntPtr parameter);
    [StructLayout(LayoutKind.Sequential)] struct RECT { public int Left, Top, Right, Bottom; }
    [StructLayout(LayoutKind.Sequential)] struct POINT { public int X, Y; }
    [StructLayout(LayoutKind.Sequential)] struct MOUSEINPUT { public int dx, dy; public uint mouseData, flags, time; public UIntPtr extra; }
    [StructLayout(LayoutKind.Sequential)] struct KEYBDINPUT { public ushort vk, scan; public uint flags, time; public UIntPtr extra; }
    [StructLayout(LayoutKind.Explicit)] struct INPUTUNION { [FieldOffset(0)] public MOUSEINPUT mouse; [FieldOffset(0)] public KEYBDINPUT keyboard; }
    [StructLayout(LayoutKind.Sequential)] struct INPUT { public uint type; public INPUTUNION data; }
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc callback, IntPtr parameter);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hwnd);
    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr hwnd);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr hwnd, StringBuilder text, int max);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr hwnd, StringBuilder text, int max);
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr hwnd, out RECT rect);
    [DllImport("user32.dll")] static extern bool ScreenToClient(IntPtr hwnd, ref POINT point);
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr hwnd);
    [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
    [DllImport("user32.dll")] static extern bool PrintWindow(IntPtr hwnd, IntPtr dc, uint flags);
    [DllImport("user32.dll", SetLastError=true)] static extern bool PostMessage(IntPtr hwnd, uint message, IntPtr wparam, IntPtr lparam);
    [DllImport("user32.dll", SetLastError=true)] static extern uint SendInput(uint count, INPUT[] input, int size);
    [DllImport("user32.dll")] static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] static extern short GetAsyncKeyState(int key);
    [DllImport("user32.dll")] static extern IntPtr ChildWindowFromPointEx(IntPtr parent, POINT point, uint flags);

    static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = 1024 * 1024 };
    static Dictionary<string, object> request;
    static string S(string key, string fallback = "") { object value; return request.TryGetValue(key, out value) && value != null ? Convert.ToString(value) : fallback; }
    static int N(string key, int fallback = 0) { object value; return request.TryGetValue(key, out value) ? Convert.ToInt32(value) : fallback; }
    static bool B(string key) { object value; return request.TryGetValue(key, out value) && Convert.ToBoolean(value); }
    static Dictionary<string, object> Obj(params object[] pairs) {
        var obj = new Dictionary<string, object>();
        for (int i = 0; i < pairs.Length; i += 2) obj[(string)pairs[i]] = pairs[i + 1];
        return obj;
    }

    [STAThread] public static int Main(string[] args) {
        Console.OutputEncoding = new UTF8Encoding(false);
        try {
            SetProcessDPIAware();
            try { SetThreadDpiAwarenessContext(new IntPtr(-4)); } catch (EntryPointNotFoundException) { }
            if (args.Length != 1) throw new Exception("Expected one base64 JSON request");
            request = Json.Deserialize<Dictionary<string, object>>(Encoding.UTF8.GetString(Convert.FromBase64String(args[0])));
            Console.WriteLine(Json.Serialize(Run()));
            return 0;
        } catch (Exception error) { Console.Error.WriteLine(error.Message); return 1; }
    }

    static List<IntPtr> Windows(string browser) {
        var windows = new List<IntPtr>();
        EnumWindows(delegate(IntPtr hwnd, IntPtr ignored) {
            if (!IsWindowVisible(hwnd)) return true;
            uint pid; GetWindowThreadProcessId(hwnd, out pid);
            try {
                string name = Process.GetProcessById((int)pid).ProcessName.ToLowerInvariant();
                if (name != "brave" && name != "zen" || browser != "" && name != browser) return true;
                var cls = new StringBuilder(256); GetClassName(hwnd, cls, cls.Capacity);
                if (cls.ToString() != "Chrome_WidgetWin_1" && cls.ToString() != "MozillaWindowClass") return true;
                var title = new StringBuilder(4096); GetWindowText(hwnd, title, title.Capacity);
                if (title.Length > 0) windows.Add(hwnd);
            } catch (ArgumentException) { }
            catch (InvalidOperationException) { }
            catch (System.ComponentModel.Win32Exception) { } // Ignore inaccessible/unrelated processes.
            return true;
        }, IntPtr.Zero);
        return windows;
    }

    static Dictionary<string, object> Info(IntPtr hwnd) {
        RECT rect; if (!GetWindowRect(hwnd, out rect)) throw new Exception("Browser window disappeared");
        uint pid; GetWindowThreadProcessId(hwnd, out pid);
        var title = new StringBuilder(4096); GetWindowText(hwnd, title, title.Capacity);
        return Obj("window_id", hwnd.ToInt64().ToString(), "process_id", pid, "browser", Process.GetProcessById((int)pid).ProcessName.ToLowerInvariant(),
            "title", title.ToString(), "x", rect.Left, "y", rect.Top, "width", rect.Right - rect.Left, "height", rect.Bottom - rect.Top,
            "minimized", IsIconic(hwnd), "foreground", GetForegroundWindow() == hwnd);
    }

    static object Run() {
        string action = S("action");
        var windows = Windows(S("browser"));
        // An explicit browser never falls back. Auto-detection favors an existing Brave session.
        if (S("browser") == "" && windows.Exists(h => (string)Info(h)["browser"] == "brave")) windows.RemoveAll(h => (string)Info(h)["browser"] != "brave");
        if (windows.Count == 0) throw new Exception("No running " + S("browser", "Brave/Zen") + " browser window. Open the browser manually; no browser will be launched.");
        IntPtr hwnd;
        if (S("window_id") != "") {
            hwnd = new IntPtr(Int64.Parse(S("window_id")));
            if (!windows.Contains(hwnd)) throw new Exception("Observed browser window no longer exists; observe again");
        } else {
            int index = N("window_index", 1) - 1;
            if (index < 0 || index >= windows.Count) throw new Exception("window_index is outside the running browser windows");
            hwnd = windows[index];
        }
        var info = Info(hwnd);
        if (action == "status") {
            var list = new List<object>(); foreach (var window in windows) list.Add(Info(window));
            return Obj("window", info, "windows", list);
        }
        if (action == "capture") return Capture(hwnd, info);
        if (action == "list_tabs" || action == "select_tab") return Tabs(hwnd, info, action);
        if (B("expected")) {
            if (N("process_id") != Convert.ToInt32(info["process_id"]) || N("width") != (int)info["width"] || N("height") != (int)info["height"])
                throw new Exception("Browser window changed or resized; observe again");
        } else throw new Exception("Input requires an observed window");
        if (IsIconic(hwnd)) throw new Exception("Browser is minimized; restore it manually and observe again");
        string mode = S("input_mode", "background");
        if (mode != "background" && mode != "foreground") throw new Exception("Invalid input_mode");
        if (action == "focus_click") {
            SetForegroundWindow(hwnd); Thread.Sleep(150);
            Foreground(hwnd); mode = "foreground";
        }
        if (mode == "foreground") { Foreground(hwnd); NoHeldModifiers(); }
        CheckCancellation();
        if (action == "type") TypeText(hwnd, mode, S("text"));
        else if (action == "key") Key(hwnd, mode, S("key"), S("modifiers"));
        else Mouse(hwnd, mode, action);
        return Obj("window", Info(hwnd), "input_mode", mode, "delivered", true, "verified", false,
            "note", "Event delivery is not proof of browser acceptance; observe to verify.");
    }

    static object Capture(IntPtr hwnd, Dictionary<string, object> info) {
        if (IsIconic(hwnd)) throw new Exception("Minimized-window capture is unsupported. Restore the browser manually; focus is never changed by observation.");
        int width = (int)info["width"], height = (int)info["height"];
        if (width <= 0 || height <= 0 || width > 16384 || height > 16384) throw new Exception("Invalid browser window size");
        using (var raw = new Bitmap(width, height, PixelFormat.Format32bppArgb)) {
            using (var graphics = Graphics.FromImage(raw)) {
                IntPtr dc = graphics.GetHdc();
                bool ok; try { ok = PrintWindow(hwnd, dc, 2); } finally { graphics.ReleaseHdc(dc); }
                if (!ok) throw new Exception("PrintWindow failed. No desktop screenshot fallback is used.");
            }
            // Chromium can expose an empty backing surface. Do not silently report a blank capture as success.
            Color first = raw.GetPixel(width / 2, height / 2); int varied = 0;
            for (int y = 0; y < height; y += Math.Max(1, height / 32))
                for (int x = 0; x < width; x += Math.Max(1, width / 32)) {
                    Color pixel = raw.GetPixel(x, y);
                    if (Math.Abs(first.R - pixel.R) + Math.Abs(first.G - pixel.G) + Math.Abs(first.B - pixel.B) > 24) varied++;
                }
            if (varied < 5) throw new Exception("Browser returned a blank backing surface. Make it visible and observe again; capture never focuses it.");
            double scale = Math.Min(1.0, Math.Max(64, Math.Min(2000, N("max_edge", 1920))) / (double)Math.Max(width, height));
            int iw = Math.Max(1, (int)Math.Round(width * scale)), ih = Math.Max(1, (int)Math.Round(height * scale));
            using (var image = new Bitmap(iw, ih)) using (var graphics = Graphics.FromImage(image)) {
                graphics.InterpolationMode = InterpolationMode.HighQualityBicubic;
                graphics.DrawImage(raw, 0, 0, iw, ih);
                if (request.ContainsKey("pointer_x")) {
                    float x = N("pointer_x") * iw / (float)width, y = N("pointer_y") * ih / (float)height;
                    using (var pen = new Pen(Color.Red, 2)) {
                        graphics.DrawEllipse(pen, x - 7, y - 7, 14, 14);
                        graphics.DrawLine(pen, x - 12, y, x + 12, y); graphics.DrawLine(pen, x, y - 12, x, y + 12);
                    }
                }
                image.Save(S("output"), ImageFormat.Png);
            }
            return Obj("window", info, "image_width", iw, "image_height", ih, "capture_mode", "PrintWindow", "focus_changed", false);
        }
    }

    static object Tabs(IntPtr hwnd, Dictionary<string, object> info, string action) {
        // Never inspect page DOM, authenticated content, cookies, or browser profile files.
        var root = AutomationElement.FromHandle(hwnd);
        var items = root.FindAll(TreeScope.Descendants, new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.TabItem));
        var tabs = new List<AutomationElement>();
        foreach (AutomationElement item in items) {
            // Brave's native tab class distinguishes browser tabs from ARIA tabs in web content.
            string cls = item.Current.ClassName;
            if ((string)info["browser"] == "brave" && cls != "BraveTab" && cls != "Tab") continue;
            if ((string)info["browser"] == "zen" && (cls != "tabbrowser-tab" || item.Current.FrameworkId != "Gecko")) continue;
            // Reject web-page tabs even if a provider uses the same class/framework.
            var parent = TreeWalker.ControlViewWalker.GetParent(item); bool document = false;
            for (int depth = 0; parent != null && depth < 40; depth++, parent = TreeWalker.ControlViewWalker.GetParent(parent)) {
                if (parent.Current.ControlType == ControlType.Document) { document = true; break; }
                if (parent.Equals(root)) break;
            }
            if (!document) tabs.Add(item);
        }
        if (tabs.Count == 0) throw new Exception("Browser tab accessibility is unavailable. Brave is supported first; Zen tab support is experimental. No debug port is required.");
        if (action == "select_tab") {
            int index = N("tab_index") - 1;
            if (index < 0 || index >= tabs.Count) throw new Exception("tab_index is outside the browser tabs");
            object pattern;
            if (!tabs[index].TryGetCurrentPattern(SelectionItemPattern.Pattern, out pattern)) throw new Exception("Browser tab does not expose SelectionItemPattern");
            ((SelectionItemPattern)pattern).Select();
        }
        var result = new List<object>();
        for (int i = 0; i < tabs.Count && i < 200; i++) {
            object pattern; bool selected = tabs[i].TryGetCurrentPattern(SelectionItemPattern.Pattern, out pattern) && ((SelectionItemPattern)pattern).Current.IsSelected;
            result.Add(Obj("tab_index", i + 1, "title", tabs[i].Current.Name, "selected", selected));
        }
        return Obj("window", Info(hwnd), "tabs", result, "truncated", tabs.Count > 200, "urls_available", false);
    }

    static void CheckCancellation() {
        string file = S("cancel_file");
        if (file != "" && System.IO.File.Exists(file)) throw new Exception("Operation aborted");
    }
    static void Foreground(IntPtr hwnd) {
        CheckCancellation();
        if (GetForegroundWindow() != hwnd) throw new Exception("Foreground input refused: browser is not active. Use explicit focus_click first.");
    }
    static void NoHeldModifiers() {
        foreach (int key in new int[] { 0x10, 0x11, 0x12, 0x5B, 0x5C })
            if ((GetAsyncKeyState(key) & 0x8000) != 0) throw new Exception("Release physical modifier keys before foreground input");
    }
    static void Send(INPUT input) {
        if (SendInput(1, new INPUT[] { input }, Marshal.SizeOf(typeof(INPUT))) != 1) throw new Exception("SendInput failed (UIPI/elevation may block input)");
    }
    static void Keyboard(ushort key, ushort scan, uint flags) { Send(new INPUT { type = 1, data = new INPUTUNION { keyboard = new KEYBDINPUT { vk = key, scan = scan, flags = flags } } }); }
    static void MouseEvent(uint flags, int data = 0) { Send(new INPUT { type = 0, data = new INPUTUNION { mouse = new MOUSEINPUT { flags = flags, mouseData = unchecked((uint)data) } } }); }
    static IntPtr Packed(int x, int y) { return new IntPtr(unchecked((int)(((uint)(ushort)y << 16) | (ushort)x))); }
    static void Post(IntPtr hwnd, uint message, int value, IntPtr point) {
        if (!PostMessage(hwnd, message, new IntPtr(value), point)) throw new Exception("PostMessage failed (UIPI/elevation may block input)");
    }
    static void Bounds(int x, int y) {
        if (x < 0 || y < 0 || x >= N("width") || y >= N("height")) throw new Exception("Point is outside observed window");
    }
    // Route to the browser's own child HWND under the point; never another application's window.
    static IntPtr Target(IntPtr hwnd, int sx, int sy, out POINT client) {
        IntPtr target = hwnd; client = new POINT { X = sx, Y = sy }; ScreenToClient(target, ref client);
        for (int i = 0; i < 20; i++) {
            IntPtr child = ChildWindowFromPointEx(target, client, 7);
            if (child == IntPtr.Zero || child == target) return target;
            target = child; client = new POINT { X = sx, Y = sy }; ScreenToClient(target, ref client);
        }
        return target;
    }
    static void Mouse(IntPtr hwnd, string mode, string action) {
        int x = N("x"), y = N("y"); Bounds(x, y);
        RECT rect; GetWindowRect(hwnd, out rect);
        POINT client; IntPtr target = Target(hwnd, rect.Left + x, rect.Top + y, out client);
        IntPtr point = Packed(client.X, client.Y);
        bool foreground = mode == "foreground";
        if (action != "move" && action != "click" && action != "focus_click" && action != "double_click" && action != "right_click" && action != "scroll" && action != "drag") throw new Exception("Unknown mouse action");
        if (foreground) { Foreground(hwnd); SetCursorPos(rect.Left + x, rect.Top + y); }
        else Post(target, 0x200, 0, point);
        if (action == "move") return;
        if (action == "scroll") {
            int dx = N("delta_x"), dy = N("delta_y", -600);
            if (foreground) { Foreground(hwnd); if (dy != 0) MouseEvent(0x800, dy); if (dx != 0) MouseEvent(0x1000, dx); }
            else {
                // WM_MOUSE(W)HEEL lParam is screen coordinates, unlike button messages.
                if (dy != 0) Post(target, 0x20A, unchecked(dy << 16), Packed(rect.Left + x, rect.Top + y));
                if (dx != 0) Post(target, 0x20E, unchecked(dx << 16), Packed(rect.Left + x, rect.Top + y));
            }
            return;
        }
        bool right = action == "right_click";
        if (action == "drag") {
            int tx = N("target_x"), ty = N("target_y"); Bounds(tx, ty);
            int duration = Math.Max(0, Math.Min(10000, N("duration_ms", 260))), steps = Math.Max(1, duration / 16);
            if (foreground) MouseEvent(2); else Post(target, 0x201, 1, point);
            try {
                for (int i = 1; i <= steps; i++) {
                    CheckCancellation();
                    int sx = rect.Left + x + (tx - x) * i / steps, sy = rect.Top + y + (ty - y) * i / steps;
                    if (foreground) { Foreground(hwnd); SetCursorPos(sx, sy); }
                    else { POINT at = new POINT { X = sx, Y = sy }; ScreenToClient(target, ref at); point = Packed(at.X, at.Y); Post(target, 0x200, 1, point); }
                    Thread.Sleep(duration / steps);
                }
            } finally { if (foreground) MouseEvent(4); else Post(target, 0x202, 0, point); }
            return;
        }
        int count = action == "double_click" ? 2 : 1;
        for (int i = 0; i < count; i++) {
            if (foreground) { Foreground(hwnd); MouseEvent(right ? 8u : 2u); MouseEvent(right ? 16u : 4u); }
            else { Post(target, i == 1 ? 0x203u : right ? 0x204u : 0x201u, right ? 2 : 1, point); Post(target, right ? 0x205u : 0x202u, 0, point); }
            Thread.Sleep(50);
        }
    }

    static void TypeText(IntPtr hwnd, string mode, string text) {
        int interval = Math.Max(0, Math.Min(1000, N("interval_ms", 8)));
        if (text.Length > 2048 || (long)text.Length * (interval + 2) > 20000) throw new Exception("Typing batch too long");
        foreach (char c in text) {
            CheckCancellation();
            if (mode == "foreground") {
                Foreground(hwnd);
                if (c == '\n') { Keyboard(13, 0, 0); Keyboard(13, 0, 2); }
                else if (c != '\r') { Keyboard(0, c, 4); Keyboard(0, c, 6); }
            } else if (c != '\r') Post(hwnd, 0x102, c == '\n' ? 13 : c, IntPtr.Zero);
            if (interval > 0) Thread.Sleep(interval);
        }
    }
    static ushort VirtualKey(string key) {
        key = key.ToLowerInvariant();
        var keys = new Dictionary<string, ushort> { {"enter",13}, {"tab",9}, {"escape",27}, {"backspace",8}, {"delete",46}, {"space",32}, {"left",37}, {"up",38}, {"right",39}, {"down",40}, {"home",36}, {"end",35}, {"pageup",33}, {"pagedown",34} };
        ushort value;
        if (keys.TryGetValue(key, out value)) return value;
        if (key.Length == 1 && (key[0] >= 'a' && key[0] <= 'z' || key[0] >= '0' && key[0] <= '9')) return (ushort)Char.ToUpperInvariant(key[0]);
        int number; if (key.StartsWith("f") && Int32.TryParse(key.Substring(1), out number) && number >= 1 && number <= 12) return (ushort)(111 + number);
        throw new Exception("Unsupported key: " + key);
    }
    static void Key(IntPtr hwnd, string mode, string key, string modifiers) {
        ushort vk = VirtualKey(key);
        if (mode == "background") {
            if (modifiers != "") throw new Exception("Background modifier shortcuts are unsupported; use explicit foreground input");
            Post(hwnd, 0x100, vk, new IntPtr(1)); Post(hwnd, 0x101, vk, new IntPtr(unchecked((int)0xC0000001))); return;
        }
        var held = new List<ushort>();
        try {
            foreach (string modifier in modifiers.Split(new char[] { ',' }, StringSplitOptions.RemoveEmptyEntries)) {
                ushort code = modifier == "control" ? (ushort)17 : modifier == "shift" ? (ushort)16 : modifier == "alt" ? (ushort)18 : (ushort)0;
                if (code == 0) throw new Exception("Unsupported modifier: " + modifier);
                Foreground(hwnd); Keyboard(code, 0, 0); held.Add(code);
            }
            Foreground(hwnd); Keyboard(vk, 0, vk >= 33 && vk <= 46 ? 1u : 0u); Keyboard(vk, 0, vk >= 33 && vk <= 46 ? 3u : 2u);
        } finally { for (int i = held.Count - 1; i >= 0; i--) Keyboard(held[i], 0, 2); }
    }
}
