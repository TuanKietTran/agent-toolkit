import AppKit
import ApplicationServices
import CoreGraphics
import Foundation
import ImageIO

struct Point {
    let x: Double
    let y: Double
}

let rawArguments = CommandLine.arguments

// Background mode: with `--pid N` every synthetic event is delivered straight into that process's
// event queue instead of the shared HID tap, so the user's focus, pointer, and keyboard are never
// taken over by automation.
let targetPID: pid_t? = {
    guard let index = rawArguments.firstIndex(of: "--pid"), index + 1 < rawArguments.count,
          let value = Int32(rawArguments[index + 1]), value > 0 else { return nil }
    return pid_t(value)
}()

let arguments: [String] = {
    guard let index = rawArguments.firstIndex(of: "--pid") else { return rawArguments }
    var copy = rawArguments
    copy.removeSubrange(index...min(index + 1, copy.count - 1))
    return copy
}()

// The synthetic pointer position. In background mode the physical cursor never moves, so this is
// the only meaningful "where is the mouse" answer.
var lastPostedPoint: CGPoint?

func fail(_ message: String) -> Never {
    FileHandle.standardError.write(Data((message + "\n").utf8))
    exit(2)
}

func number(_ index: Int, _ name: String) -> Double {
    guard arguments.count > index, let value = Double(arguments[index]), value.isFinite else {
        fail("Missing or invalid \(name)")
    }
    return value
}

func optionalNumber(_ index: Int) -> Double? {
    guard arguments.count > index, let value = Double(arguments[index]), value.isFinite else { return nil }
    return value
}

func integer(_ index: Int, _ name: String) -> Int {
    guard arguments.count > index, let value = Int(arguments[index]) else {
        fail("Missing or invalid \(name)")
    }
    return value
}

func emit(_ value: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: value), let text = String(data: data, encoding: .utf8) else {
        fail("Could not encode result")
    }
    print(text)
}

func requireAccessibility() {
    if !AXIsProcessTrusted() {
        fail("Accessibility permission is required. Run /mac-browser permissions, then enable your terminal or Pi in System Settings > Privacy & Security > Accessibility.")
    }
}

func currentCursor() -> CGPoint {
    CGEvent(source: nil)?.location ?? .zero
}

func rectJSON(_ rect: CGRect) -> [String: Double] {
    ["x": Double(rect.origin.x), "y": Double(rect.origin.y), "width": Double(rect.width), "height": Double(rect.height)]
}

func area(_ rect: CGRect) -> Double {
    rect.isNull ? 0 : Double(rect.width * rect.height)
}

func activeDisplays() -> [CGRect] {
    var count: UInt32 = 0
    guard CGGetActiveDisplayList(0, nil, &count) == .success, count > 0 else { return [CGDisplayBounds(CGMainDisplayID())] }
    var ids = [CGDirectDisplayID](repeating: 0, count: Int(count))
    guard CGGetActiveDisplayList(count, &ids, &count) == .success else { return [CGDisplayBounds(CGMainDisplayID())] }
    return ids.prefix(Int(count)).map { CGDisplayBounds($0) }
}

struct BrowserWindow {
    let id: CGWindowID
    let pid: pid_t
    let rect: CGRect
    let onScreen: Bool
    let title: String
}

// Normal-layer browser windows, including covered, minimized, and other-Space windows.
// CGWindowList is not ordered like the browser's AppleScript window list, so match the active
// tab title when available. Otherwise prefer an on-screen window over stale off-screen surfaces.
func browserWindow(_ name: String, preferredTitle: String? = nil) -> BrowserWindow? {
    guard !name.isEmpty,
          let list = CGWindowListCopyWindowInfo([.excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else { return nil }
    let windows = list.compactMap { info -> BrowserWindow? in
        guard (info[kCGWindowOwnerName as String] as? String) == name,
              (info[kCGWindowLayer as String] as? Int) == 0,
              let number = info[kCGWindowNumber as String] as? NSNumber,
              let ownerPID = info[kCGWindowOwnerPID as String] as? NSNumber,
              let bounds = info[kCGWindowBounds as String] as? NSDictionary,
              let rect = CGRect(dictionaryRepresentation: bounds as CFDictionary),
              rect.width >= 200, rect.height >= 150 else { return nil }
        return BrowserWindow(
            id: CGWindowID(number.uint32Value),
            pid: pid_t(ownerPID.int32Value),
            rect: rect,
            onScreen: (info[kCGWindowIsOnscreen as String] as? Bool) ?? false,
            title: (info[kCGWindowName as String] as? String) ?? ""
        )
    }
    if let preferredTitle, !preferredTitle.isEmpty,
       let exact = windows.first(where: { $0.title == preferredTitle }) {
        return exact
    }
    return windows.first(where: { $0.onScreen }) ?? windows.first
}

func targetDisplay(displays: [CGRect], window: CGRect?, cursor: CGPoint) -> CGRect {
    if let window, let best = displays.max(by: { area($0.intersection(window)) < area($1.intersection(window)) }),
       area(best.intersection(window)) > 0 {
        return best
    }
    return displays.first { $0.contains(cursor) } ?? CGDisplayBounds(CGMainDisplayID())
}

func mouseButton(_ name: String) -> (CGMouseButton, CGEventType, CGEventType) {
    switch name.lowercased() {
    case "left": return (.left, .leftMouseDown, .leftMouseUp)
    case "right": return (.right, .rightMouseDown, .rightMouseUp)
    case "middle": return (.center, .otherMouseDown, .otherMouseUp)
    default: fail("Unsupported mouse button: \(name)")
    }
}

// Flags are cleared so physically held modifiers never turn a click into cmd/shift-click.
// Background events bypass the HID tap entirely: nothing reaches the frontmost app, the physical
// cursor stays where the user left it, and held modifiers cannot leak into the click.
func post(_ event: CGEvent) {
    if let pid = targetPID { event.postToPid(pid) } else { event.post(tap: .cghidEventTap) }
}

func reportCursor() -> CGPoint {
    targetPID != nil ? (lastPostedPoint ?? currentCursor()) : currentCursor()
}

func postMouse(_ type: CGEventType, _ point: CGPoint, _ button: CGMouseButton, clickState: Int64 = 0) {
    guard let event = CGEvent(mouseEventSource: nil, mouseType: type, mouseCursorPosition: point, mouseButton: button) else {
        fail("Could not create mouse event")
    }
    event.flags = []
    if clickState > 0 { event.setIntegerValueField(.mouseEventClickState, value: clickState) }
    lastPostedPoint = point
    post(event)
}

func moveMouse(from: CGPoint, to: CGPoint, durationMs: Int) {
    // Background delivery cannot (and must not) drag the physical pointer across the screen, so a
    // single synthetic move is enough to establish hover state without fighting the user's mouse.
    if targetPID != nil {
        postMouse(.mouseMoved, to, .left)
        return
    }
    let steps = max(1, min(240, durationMs <= 0 ? 1 : durationMs / 8))
    for step in 1...steps {
        let amount = Double(step) / Double(steps)
        let eased = amount * amount * (3.0 - 2.0 * amount)
        let point = CGPoint(x: from.x + (to.x - from.x) * eased, y: from.y + (to.y - from.y) * eased)
        postMouse(.mouseMoved, point, .left)
        if durationMs > 0 { usleep(useconds_t(durationMs * 1000 / steps)) }
    }
}

func postKey(_ code: CGKeyCode, flags: CGEventFlags, unicode: [UniChar]? = nil, holdMicros: useconds_t) {
    guard let down = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: true),
          let up = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: false) else { fail("Could not create keyboard event") }
    down.flags = flags; up.flags = flags
    if var units = unicode {
        down.keyboardSetUnicodeString(stringLength: units.count, unicodeString: &units)
        up.keyboardSetUnicodeString(stringLength: units.count, unicodeString: &units)
    }
    post(down); usleep(holdMicros); post(up)
}

let keyCodes: [String: CGKeyCode] = [
    "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7, "c": 8, "v": 9,
    "b": 11, "q": 12, "w": 13, "e": 14, "r": 15, "y": 16, "t": 17, "1": 18, "2": 19,
    "3": 20, "4": 21, "6": 22, "5": 23, "=": 24, "9": 25, "7": 26, "-": 27, "8": 28,
    "0": 29, "]": 30, "o": 31, "u": 32, "[": 33, "i": 34, "p": 35, "enter": 36, "return": 36,
    "l": 37, "j": 38, "'": 39, "k": 40, ";": 41, "\\": 42, ",": 43, "/": 44,
    "n": 45, "m": 46, ".": 47, "tab": 48, "space": 49, "`": 50, "delete": 51, "backspace": 51,
    "escape": 53, "esc": 53, "home": 115, "pageup": 116, "forwarddelete": 117, "end": 119, "pagedown": 121,
    "left": 123, "right": 124, "down": 125, "up": 126,
    "arrowleft": 123, "arrowright": 124, "arrowdown": 125, "arrowup": 126,
    "f1": 122, "f2": 120, "f3": 99, "f4": 118, "f5": 96, "f6": 97, "f7": 98, "f8": 100,
    "f9": 101, "f10": 109, "f11": 103, "f12": 111
]

func flags(_ text: String) -> CGEventFlags {
    var output: CGEventFlags = []
    for part in text.lowercased().split(separator: ",") {
        switch part.trimmingCharacters(in: .whitespaces) {
        case "command", "cmd", "meta": output.insert(.maskCommand)
        case "shift": output.insert(.maskShift)
        case "option", "alt": output.insert(.maskAlternate)
        case "control", "ctrl": output.insert(.maskControl)
        case "", "none": break
        default: fail("Unsupported modifier: \(part)")
        }
    }
    return output
}

func parseTrail(_ text: String) -> [Point] {
    text.split(separator: ";").compactMap { pair in
        let values = pair.split(separator: ",")
        guard values.count == 2, let x = Double(values[0]), let y = Double(values[1]) else { return nil }
        return Point(x: x, y: y)
    }
}

// Small, quantized luminance grid for rejecting JPEG noise and tiny hover effects.
func fingerprint(input: String) -> String {
    guard let source = CGImageSourceCreateWithURL(URL(fileURLWithPath: input) as CFURL, nil),
          let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else { fail("Could not read screenshot") }
    let width = 64, height = 36
    var pixels = [UInt8](repeating: 0, count: width * height * 4)
    let drawn = pixels.withUnsafeMutableBytes { memory -> Bool in
        guard let context = CGContext(data: memory.baseAddress, width: width, height: height, bitsPerComponent: 8,
                                      bytesPerRow: width * 4, space: CGColorSpaceCreateDeviceRGB(),
                                      bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue) else { return false }
        context.interpolationQuality = .high
        context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
        return true
    }
    if !drawn { fail("Could not create fingerprint canvas") }
    var result = ""
    result.reserveCapacity(width * height * 2)
    for index in 0..<(width * height) {
        let offset = index * 4
        let luminance = (Int(pixels[offset]) * 54 + Int(pixels[offset + 1]) * 183 + Int(pixels[offset + 2]) * 19) / 256
        let quantized = UInt8(luminance & 0xf0)
        result += String(format: "%02x", quantized)
    }
    return result
}

// Renders into a bitmap of exactly width x height pixels so output size never depends on Retina scale.
func annotate(input: String, output: String, trail: [Point], frame: CGRect, width: Int, height: Int) {
    guard let source = CGImageSourceCreateWithURL(URL(fileURLWithPath: input) as CFURL, nil),
          let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else { fail("Could not read screenshot") }
    guard let context = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0,
                                  space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue) else {
        fail("Could not create annotation canvas")
    }
    context.interpolationQuality = .high
    context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))

    let sx = Double(width) / Double(frame.width)
    let sy = Double(height) / Double(frame.height)
    func imagePoint(_ point: Point) -> CGPoint {
        CGPoint(x: (point.x - Double(frame.origin.x)) * sx, y: Double(height) - (point.y - Double(frame.origin.y)) * sy)
    }
    let red = CGColor(red: 1, green: 0.23, blue: 0.19, alpha: 1)
    context.setLineCap(.round)
    if trail.count > 1 {
        context.setLineWidth(3)
        context.setStrokeColor(red.copy(alpha: 0.55) ?? red)
        context.move(to: imagePoint(trail[0]))
        for point in trail.dropFirst() { context.addLine(to: imagePoint(point)) }
        context.strokePath()
    }
    if let last = trail.last {
        let point = imagePoint(last)
        let radius = 10.0
        let circle = CGRect(x: point.x - radius, y: point.y - radius, width: radius * 2, height: radius * 2)
        context.setLineWidth(3)
        context.setStrokeColor(CGColor(red: 1, green: 1, blue: 1, alpha: 0.95))
        context.strokeEllipse(in: circle)
        context.setLineWidth(1.5)
        context.setStrokeColor(red)
        context.strokeEllipse(in: circle)
        context.setLineWidth(2)
        context.move(to: CGPoint(x: point.x - radius * 1.45, y: point.y))
        context.addLine(to: CGPoint(x: point.x + radius * 1.45, y: point.y))
        context.move(to: CGPoint(x: point.x, y: point.y - radius * 1.45))
        context.addLine(to: CGPoint(x: point.x, y: point.y + radius * 1.45))
        context.strokePath()
    }

    guard let rendered = context.makeImage(),
          let destination = CGImageDestinationCreateWithURL(URL(fileURLWithPath: output) as CFURL, "public.jpeg" as CFString, 1, nil) else {
        fail("Could not encode annotated screenshot")
    }
    CGImageDestinationAddImage(destination, rendered, [kCGImageDestinationLossyCompressionQuality: 0.8] as CFDictionary)
    if !CGImageDestinationFinalize(destination) { fail("Could not write annotated screenshot") }
}

guard arguments.count >= 2 else { fail("Missing command") }
let command = arguments[1]

// Mouse and keyboard commands are background-only. Refuse to execute rather than ever falling back
// to the shared HID event stream, even if a caller invokes this helper directly or passes bad args.
let inputCommands: Set<String> = ["move", "click", "drag", "release", "scroll", "type", "key"]
if inputCommands.contains(command) && targetPID == nil {
    fail("Refusing system-wide input: background commands require --pid <browser-pid>")
}

switch command {
case "status":
    let browserName = arguments.count > 2 ? arguments[2] : ""
    let preferredTitle = arguments.count > 3 && !arguments[3].isEmpty ? arguments[3] : nil
    let cursor = currentCursor()
    let displays = activeDisplays()
    let window = browserWindow(browserName, preferredTitle: preferredTitle)
    let app = NSWorkspace.shared.frontmostApplication
    emit([
        "accessibility": AXIsProcessTrusted(),
        "screenRecording": CGPreflightScreenCaptureAccess(),
        "cursor": ["x": cursor.x, "y": cursor.y],
        "mainDisplay": rectJSON(CGDisplayBounds(CGMainDisplayID())),
        "displays": displays.map(rectJSON),
        "targetDisplay": rectJSON(targetDisplay(displays: displays, window: window?.rect, cursor: cursor)),
        "browserWindow": window.map { rectJSON($0.rect) as Any } ?? NSNull(),
        "browserWindowId": window.map { Int($0.id) as Any } ?? NSNull(),
        "browserPid": window.map { Int($0.pid) as Any } ?? NSNull(),
        "browserWindowOnScreen": window?.onScreen ?? false,
        "browserWindowTitle": window?.title ?? "",
        "frontmostApp": app?.localizedName ?? "",
        "frontmostBundleId": app?.bundleIdentifier ?? ""
    ])
case "request-permissions":
    let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
    let accessibility = AXIsProcessTrustedWithOptions(options)
    let screenRecording = CGPreflightScreenCaptureAccess() || CGRequestScreenCaptureAccess()
    emit(["accessibility": accessibility, "screenRecording": screenRecording])
case "move":
    requireAccessibility()
    let target = CGPoint(x: number(2, "x"), y: number(3, "y"))
    moveMouse(from: currentCursor(), to: target, durationMs: integer(4, "durationMs"))
    emit(["cursor": ["x": target.x, "y": target.y]])
case "click", "foreground-click":
    requireAccessibility()
    if command == "foreground-click" && targetPID != nil {
        fail("foreground-click must use the shared HID stream without --pid")
    }
    let target = CGPoint(x: number(2, "x"), y: number(3, "y"))
    let (button, down, up) = mouseButton(arguments.count > 4 ? arguments[4] : "left")
    let count = max(1, min(3, integer(5, "count")))
    moveMouse(from: currentCursor(), to: target, durationMs: integer(6, "durationMs"))
    usleep(30_000)
    for click in 1...count {
        postMouse(down, target, button, clickState: Int64(click)); usleep(45_000)
        postMouse(up, target, button, clickState: Int64(click))
        if click < count { usleep(70_000) }
    }
    emit(["cursor": ["x": target.x, "y": target.y], "foreground": command == "foreground-click"])
case "drag":
    requireAccessibility()
    let start = CGPoint(x: number(2, "x"), y: number(3, "y"))
    let target = CGPoint(x: number(4, "targetX"), y: number(5, "targetY"))
    let (button, down, up) = mouseButton(arguments.count > 6 ? arguments[6] : "left")
    let duration = integer(7, "durationMs")
    moveMouse(from: currentCursor(), to: start, durationMs: min(180, duration / 3))
    postMouse(down, start, button, clickState: 1); usleep(70_000)
    let dragType: CGEventType = button == .left ? .leftMouseDragged : (button == .right ? .rightMouseDragged : .otherMouseDragged)
    let steps = max(2, min(240, duration / 8))
    for step in 1...steps {
        let amount = Double(step) / Double(steps)
        let point = CGPoint(x: start.x + (target.x - start.x) * amount, y: start.y + (target.y - start.y) * amount)
        postMouse(dragType, point, button, clickState: 1)
        usleep(useconds_t(max(1, duration) * 1000 / steps))
    }
    postMouse(up, target, button, clickState: 1)
    emit(["cursor": ["x": target.x, "y": target.y]])
case "release":
    let (button, _, up) = mouseButton(arguments.count > 2 ? arguments[2] : "left")
    postMouse(up, reportCursor(), button)
    emit(["released": true])
case "scroll":
    requireAccessibility()
    var remainingX = max(-20_000, min(20_000, Int(number(2, "deltaX"))))
    var remainingY = max(-20_000, min(20_000, Int(number(3, "deltaY"))))
    if let x = optionalNumber(4), let y = optionalNumber(5) {
        moveMouse(from: currentCursor(), to: CGPoint(x: x, y: y), durationMs: arguments.count > 6 ? integer(6, "durationMs") : 0)
        usleep(60_000)
    }
    // Chunked so large deltas are not clamped or coalesced by the browser.
    repeat {
        let stepX = max(-240, min(240, remainingX))
        let stepY = max(-240, min(240, remainingY))
        guard let event = CGEvent(scrollWheelEvent2Source: nil, units: .pixel, wheelCount: 2, wheel1: Int32(stepY), wheel2: Int32(stepX), wheel3: 0) else {
            fail("Could not create scroll event")
        }
        event.flags = []
        // Scroll events carry their own location; aim them at the synthetic pointer so background
        // scrolling never depends on where the user's real cursor happens to rest.
        if targetPID != nil, let point = lastPostedPoint { event.location = point }
        post(event)
        remainingX -= stepX; remainingY -= stepY
        usleep(16_000)
    } while remainingX != 0 || remainingY != 0
    let cursor = reportCursor()
    emit(["cursor": ["x": cursor.x, "y": cursor.y]])
case "type":
    requireAccessibility()
    guard arguments.count >= 4 else { fail("type requires text and intervalMs") }
    let text = arguments[2].replacingOccurrences(of: "\r\n", with: "\n")
    let interval = max(0, integer(3, "intervalMs"))
    for scalar in text.unicodeScalars {
        switch scalar {
        case "\n", "\r": postKey(36, flags: [], holdMicros: 3_000)
        case "\t": postKey(48, flags: [], holdMicros: 3_000)
        default: postKey(0, flags: [], unicode: Array(String(scalar).utf16), holdMicros: 3_000)
        }
        if interval > 0 { usleep(useconds_t(interval * 1000)) }
    }
    emit(["typedCharacters": text.count])
case "key":
    requireAccessibility()
    guard arguments.count >= 4 else { fail("key requires key and modifiers") }
    let name = arguments[2].lowercased()
    guard let code = keyCodes[name] else { fail("Unsupported key: \(name)") }
    postKey(code, flags: flags(arguments[3]), holdMicros: 35_000)
    emit(["key": name, "modifiers": arguments[3]])
case "fingerprint":
    guard arguments.count >= 3 else { fail("fingerprint requires screenshot path") }
    print(fingerprint(input: arguments[2]))
case "annotate":
    guard arguments.count >= 11 else { fail("annotate requires input, output, trail, display x/y/width/height, and image width/height") }
    let frame = CGRect(x: number(5, "displayX"), y: number(6, "displayY"), width: number(7, "displayWidth"), height: number(8, "displayHeight"))
    let width = max(1, integer(9, "imageWidth"))
    let height = max(1, integer(10, "imageHeight"))
    annotate(input: arguments[2], output: arguments[3], trail: parseTrail(arguments[4]), frame: frame, width: width, height: height)
    emit(["output": arguments[3], "width": width, "height": height])
default:
    fail("Unknown command: \(command)")
}
