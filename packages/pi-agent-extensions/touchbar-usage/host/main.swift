// Native Touch Bar quota charts. Uses private macOS Touch Bar presentation APIs.
import AppKit
import CoreGraphics
import ObjectiveC

private let itemIdentifier = NSTouchBarItem.Identifier("dev.handlerone.usagebar.item")
private let chartIdentifier = NSTouchBarItem.Identifier("dev.handlerone.usagebar.charts")
private let dfr = dlopen("/System/Library/PrivateFrameworks/DFRFoundation.framework/DFRFoundation", RTLD_NOW)
private typealias PresenceFn = @convention(c) (NSString, ObjCBool) -> Void
private typealias BoolFn = @convention(c) (ObjCBool) -> Void

private func symbol<T>(_ name: String, as type: T.Type) -> T? {
    guard let dfr, let address = dlsym(dfr, name) else { return nil }
    return unsafeBitCast(address, to: type)
}

private struct Quota {
    let label: String
    let percent: Double?
    let resetsAt: TimeInterval?
    let stale: Bool
}

private enum UsageReader {
    static func read(force: Bool) -> [Quota]? {
        let task = Process()
        task.executableURL = URL(fileURLWithPath: "/bin/sh")
        guard let script = Bundle.main.resourceURL?
            .appendingPathComponent("bin/pi-usagebar").path else { return nil }
        task.arguments = [script, "--json"] + (force ? ["--force"] : [])
        let pipe = Pipe()
        task.standardOutput = pipe
        task.standardError = FileHandle.nullDevice
        do { try task.run() } catch { return nil }
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        task.waitUntilExit()
        guard task.terminationStatus == 0,
              let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else { return nil }
        var quotas: [Quota] = []
        for (key, label) in [("claude", "CC"), ("codex", "CX")] {
            guard let side = root[key] as? [String: Any] else {
                quotas.append(Quota(label: label, percent: nil, resetsAt: nil, stale: true))
                continue
            }
            let age = Date().timeIntervalSince1970 - ((side["at"] as? Double) ?? 0) / 1000
            let stale = (side["ok"] as? Bool) != true || age > 900
            let windows = side["windows"] as? [[String: Any]] ?? []
            if windows.isEmpty {
                quotas.append(Quota(label: label, percent: nil, resetsAt: nil, stale: true))
            }
            for window in windows {
                let resetsAt = (window["resetsAt"] as? NSNumber).map { $0.doubleValue / 1000 }
                quotas.append(Quota(label: "\(label) \((window["label"] as? String) ?? "?")",
                                    percent: (window["percent"] as? NSNumber)?.doubleValue,
                                    resetsAt: resetsAt, stale: stale))
            }
        }
        return quotas
    }
}

// Fixed-width, left-aligned cards with a visible track even at zero usage.
private final class QuotaChart: NSView {
    var quotas: [Quota] = [] { didSet { needsDisplay = true } }
    override var intrinsicContentSize: NSSize { NSSize(width: 340, height: 30) }
    override func draw(_ dirtyRect: NSRect) {
        NSColor.black.setFill()
        bounds.fill()
        let visible = Array(quotas.prefix(4))
        guard !visible.isEmpty else {
            drawText("Usage loading…", at: NSPoint(x: 8, y: 9), color: .secondaryLabelColor)
            return
        }
        let width = min(110, max(0, bounds.width - 8) / CGFloat(visible.count))
        for (index, quota) in visible.enumerated() {
            let x = 6 + CGFloat(index) * width
            NSGraphicsContext.saveGraphicsState()
            NSBezierPath(rect: NSRect(x: x, y: 0, width: max(0, width - 6), height: bounds.height)).addClip()
            let value = quota.percent.map { "\(Int($0.rounded()))%" } ?? "—"
            let color: NSColor = quota.stale ? .systemOrange :
                ((quota.percent ?? 0) >= 90 ? .systemRed : .systemGreen)
            // Put the reset countdown on every card rather than showing only
            // the earliest reset for the provider.
            drawText(quota.label, at: NSPoint(x: x, y: 17), color: .lightGray)
            if let reset = resetText(quota.resetsAt) {
                drawTextRight("↻\(reset)", rightEdge: x + width - 7, y: 17,
                              color: .secondaryLabelColor)
            }
            drawText("\(value)\(quota.stale ? " !" : "")",
                     at: NSPoint(x: x, y: 5), color: color)
            let track = NSRect(x: x + 39, y: 8, width: max(0, width - 49), height: 4)
            NSColor.darkGray.setFill()
            NSBezierPath(roundedRect: track, xRadius: 2.5, yRadius: 2.5).fill()
            if let percent = quota.percent, percent.isFinite, percent > 0 {
                let fill = NSRect(x: track.minX, y: track.minY,
                                  width: track.width * min(100, max(0, percent)) / 100,
                                  height: track.height)
                color.setFill()
                NSBezierPath(roundedRect: fill, xRadius: 2.5, yRadius: 2.5).fill()
            }
            NSGraphicsContext.restoreGraphicsState()
        }
    }
    private let textAttributes: [NSAttributedString.Key: Any] = [
        .font: NSFont.monospacedDigitSystemFont(ofSize: 10, weight: .medium),
    ]

    private func resetText(_ epochSeconds: TimeInterval?) -> String? {
        guard let epochSeconds else { return nil }
        let seconds = epochSeconds - Date().timeIntervalSince1970
        guard seconds > 0 else { return "now" }
        let minutes = max(1, Int(ceil(seconds / 60)))
        if minutes < 60 { return "\(minutes)m" }
        let hours = minutes / 60
        if hours < 24 {
            let remainder = minutes % 60
            return remainder == 0 ? "\(hours)h" : "\(hours)h\(remainder)m"
        }
        return "\(Int(ceil(Double(hours) / 24)))d"
    }

    private func drawText(_ text: String, at point: NSPoint, color: NSColor) {
        var attributes = textAttributes
        attributes[.foregroundColor] = color
        (text as NSString).draw(at: point, withAttributes: attributes)
    }

    private func drawTextRight(_ text: String, rightEdge: CGFloat, y: CGFloat, color: NSColor) {
        var attributes = textAttributes
        attributes[.foregroundColor] = color
        let width = (text as NSString).size(withAttributes: attributes).width
        (text as NSString).draw(at: NSPoint(x: rightEdge - width, y: y), withAttributes: attributes)
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate, NSTouchBarDelegate {
    private let chart = QuotaChart()
    private var usageBar: NSTouchBar?
    private var trayItem: NSCustomTouchBarItem?
    private var timer: Timer?
    private var refreshing = false
    private weak var optimizeButton: NSButton?
    private var optimizing = false

    func applicationDidFinishLaunching(_ notification: Notification) {
        let tray = NSCustomTouchBarItem(identifier: itemIdentifier)
        tray.view = NSButton(title: "π", target: self, action: #selector(showCharts))
        trayItem = tray
        let cls = NSTouchBarItem.self as AnyObject
        let add = NSSelectorFromString("addSystemTrayItem:")
        guard cls.responds(to: add) else { fail("addSystemTrayItem unavailable"); return }
        _ = cls.perform(add, with: tray)
        let bar = NSTouchBar()
        bar.delegate = self
        bar.defaultItemIdentifiers = [chartIdentifier, .flexibleSpace]
        usageBar = bar
        // Let the tray registration reach TouchBarServer before presenting.
        symbol("DFRElementSetControlStripPresenceForIdentifier", as: PresenceFn.self)?(
            itemIdentifier.rawValue as NSString, true)
        DispatchQueue.main.asyncAfter(deadline: .now() + 1) { [weak self] in
            self?.showCharts()
        }
        timer = Timer.scheduledTimer(withTimeInterval: 15, repeats: true) { [weak self] _ in
            self?.refresh(force: false)
        }
        NSWorkspace.shared.notificationCenter.addObserver(
            forName: NSWorkspace.didWakeNotification, object: nil, queue: .main
        ) { [weak self] _ in
            // Updating data must never undo a user's dismissal.
            self?.refresh(force: true)
        }
        // Do not seize the app-controls region on app, window, or Space changes.
        // After dismissal the tray button is the only way to reopen this bar.
        refresh(force: false)
    }

    func touchBar(_ touchBar: NSTouchBar, makeItemForIdentifier identifier: NSTouchBarItem.Identifier) -> NSTouchBarItem? {
        guard identifier == chartIdentifier else { return nil }
        let item = NSCustomTouchBarItem(identifier: identifier)
        chart.translatesAutoresizingMaskIntoConstraints = false
        let optimize = NSButton(title: "Optimize", target: self, action: #selector(optimizeContext))
        optimize.bezelColor = .systemGreen
        optimize.toolTip = "Ask the selected Pi session to compact over local IPC; never sends keyboard input"
        optimizeButton = optimize
        optimize.translatesAutoresizingMaskIntoConstraints = false
        let stack = NSStackView(views: [chart, optimize])
        stack.orientation = .horizontal
        stack.alignment = .centerY
        stack.spacing = 6
        item.view = stack
        // A preferred compact width can yield on narrower Touch Bar layouts.
        let preferredWidth = chart.widthAnchor.constraint(equalToConstant: 340)
        preferredWidth.priority = .defaultHigh
        preferredWidth.isActive = true
        chart.widthAnchor.constraint(lessThanOrEqualToConstant: 340).isActive = true
        chart.heightAnchor.constraint(equalToConstant: 30).isActive = true
        optimize.widthAnchor.constraint(equalToConstant: 72).isActive = true
        optimize.heightAnchor.constraint(equalToConstant: 28).isActive = true
        return item
    }

    @objc private func optimizeContext() {
        guard !optimizing else { return }
        optimizing = true
        optimizeButton?.title = "Sending…"
        // The target is published by Pi itself. This request never focuses a
        // terminal or synthesizes a keystroke into the user's active app.
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            let targetURL = FileManager.default.homeDirectoryForCurrentUser
                .appendingPathComponent(".pi/optimize-target.json")
            var result = "No Pi"
            if let data = try? Data(contentsOf: targetURL),
               let target = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
               let socket = target["socket"] as? String,
               socket.hasPrefix(FileManager.default.homeDirectoryForCurrentUser.path + "/.pi/optimize-"),
               socket.hasSuffix(".sock") {
                let task = Process()
                task.executableURL = URL(fileURLWithPath: "/usr/bin/nc")
                task.arguments = ["-U", socket]
                let input = Pipe(), output = Pipe()
                task.standardInput = input
                task.standardOutput = output
                task.standardError = FileHandle.nullDevice
                do {
                    try task.run()
                    input.fileHandleForWriting.write(Data("optimize\n".utf8))
                    try? input.fileHandleForWriting.close()
                    DispatchQueue.global().asyncAfter(deadline: .now() + 3) {
                        if task.isRunning { task.terminate() }
                    }
                    let response = String(data: output.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8)?
                        .trimmingCharacters(in: .whitespacesAndNewlines)
                    task.waitUntilExit()
                    result = response == "accepted" ? "Sent" : response == "busy" ? "Pi busy" : "No Pi"
                } catch { result = "No Pi" }
            }
            DispatchQueue.main.async {
                self?.optimizeButton?.title = result
                self?.optimizing = false
                DispatchQueue.main.asyncAfter(deadline: .now() + 2) { [weak self] in
                    self?.optimizeButton?.title = "Optimize"
                }
            }
        }
    }

    @objc private func showCharts() {
        guard let usageBar else { return }
        let cls = NSTouchBar.self as AnyObject
        // The no-placement variant reserves the system Control Strip region.
        // Explicit placement 1 is the full-width / hidden-Control-Strip mode,
        // not a left alignment setting; it can collide with right-side controls.
        let present = NSSelectorFromString("presentSystemModalTouchBar:systemTrayItemIdentifier:")
        guard cls.responds(to: present) else {
            fail("left-side Touch Bar presentation unavailable")
            return
        }
        symbol("DFRSystemModalShowsCloseBoxWhenFrontMost", as: BoolFn.self)?(true)
        symbol("DFRElementSetControlStripPresenceForIdentifier", as: PresenceFn.self)?(
            itemIdentifier.rawValue as NSString, true)
        _ = cls.perform(present, with: usageBar, with: itemIdentifier.rawValue as NSString)
        refresh(force: false)
    }

    private func refresh(force: Bool) {
        guard !refreshing else { return }
        refreshing = true
        DispatchQueue.global(qos: .utility).async { [weak self] in
            let next = UsageReader.read(force: force)
            DispatchQueue.main.async {
                self?.refreshing = false
                if let next { self?.chart.quotas = next }
            }
        }
    }
    private func fail(_ message: String) {
        FileHandle.standardError.write(Data("usagebar: \(message)\n".utf8))
        NSApp.terminate(nil)
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.accessory)
app.run()
