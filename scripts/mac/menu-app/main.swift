import AppKit
import Foundation

final class AppDelegate: NSObject, NSApplicationDelegate, NSMenuDelegate {
    private var item: NSStatusItem!
    private let menu = NSMenu()
    private let dev = NSMenuItem(title: "DevSpace: checking…", action: nil, keyEquivalent: "")
    private let router = NSMenuItem(title: "Router: checking…", action: nil, keyEquivalent: "")
    private let start = NSMenuItem(title: "Start DevSpace", action: #selector(startDev), keyEquivalent: "")
    private let stop = NSMenuItem(title: "Stop DevSpace", action: #selector(stopDev), keyEquivalent: "")
    private let diagnose = NSMenuItem(title: "Check startup configuration", action: #selector(diagnoseStartup), keyEquivalent: "")
    private let feedback = NSMenuItem(title: "", action: nil, keyEquivalent: "")
    private let manager = DevSpaceManager()
    private var timer: Timer?
    private var busy = false

    private func statusText(_ name: String, online: Bool, detail: String = "") -> NSAttributedString {
        let value = NSMutableAttributedString(string: "\(name)    ")
        value.append(NSAttributedString(string: online ? "● Online" : "● Offline", attributes: [
            .foregroundColor: online ? NSColor.systemGreen : NSColor.systemRed,
            .font: NSFont.systemFont(ofSize: 14, weight: .medium)
        ]))
        if !detail.isEmpty { value.append(NSAttributedString(string: "  · \(detail)")) }
        return value
    }

    private func setStatusIcon() {
        if let path = Bundle.main.path(forResource: "SeanTemplate", ofType: "png"),
           let icon = NSImage(contentsOfFile: path) {
            icon.size = NSSize(width: 21, height: 21)
            icon.isTemplate = true
            item.button?.image = icon
            item.button?.imagePosition = .imageOnly
        } else {
            item.button?.title = "◈"
        }
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)
        item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        item.button?.title = "◈"
        setStatusIcon()
        item.button?.toolTip = "CodasSol DevSpace"
        item.menu = menu
        menu.delegate = self
        menu.autoenablesItems = false
        let heading = NSMenuItem(title: "CodasSol-mac", action: nil, keyEquivalent: "")
        heading.isEnabled = true
        menu.addItem(heading)
        menu.addItem(.separator())
        dev.isEnabled = true
        router.isEnabled = true
        menu.addItem(dev)
        menu.addItem(router)
        menu.addItem(.separator())
        start.target = self
        stop.target = self
        diagnose.target = self
        menu.addItem(start)
        menu.addItem(stop)
        menu.addItem(diagnose)
        menu.addItem(.separator())
        feedback.isEnabled = true
        menu.addItem(feedback)
        menu.addItem(NSMenuItem(title: "Quit menu app", action: #selector(quit), keyEquivalent: "q"))
        menu.items.last?.target = self
        refresh()
        timer = Timer.scheduledTimer(withTimeInterval: 3, repeats: true) { [weak self] _ in self?.refresh() }
    }

    private func health(_ port: Int, path: String) -> (online: Bool, backend: Bool) {
        let sem = DispatchSemaphore(value: 0)
        var success = false
        var backend = false
        var request = URLRequest(url: URL(string: "http://127.0.0.1:\(port)\(path)")!)
        request.timeoutInterval = 1.5
        URLSession.shared.dataTask(with: request) { data, response, _ in
            if let http = response as? HTTPURLResponse, http.statusCode == 200,
               let data, let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
                success = json["ok"] as? Bool == true
                backend = json["backendReachable"] as? Bool ?? success
            }
            sem.signal()
        }.resume()
        _ = sem.wait(timeout: .now() + 2)
        return (success, backend)
    }

    private func refresh() {
        guard !busy else { return }
        DispatchQueue.global(qos: .utility).async {
            let devOK = self.health(7676, path: "/healthz").online
            let routerHealth = self.health(17676, path: "/_codassol/health")
            let managed = self.manager.isManaged()
            DispatchQueue.main.async {
                self.dev.attributedTitle = self.statusText("DevSpace", online: devOK, detail: devOK && !managed ? "Externally started" : "")
                self.router.attributedTitle = self.statusText("Router", online: routerHealth.online, detail: routerHealth.online && !routerHealth.backend ? "Backend unreachable" : "")
                self.item.button?.alphaValue = devOK && routerHealth.online && routerHealth.backend ? 1 : 0.45
                self.start.isEnabled = !devOK
                self.stop.isEnabled = devOK && managed
                let info = self.feedback.title
                if info.isEmpty || info == "DevSpace is running outside this app" {
                    self.feedback.title = devOK && !managed ? "DevSpace is running outside this app" : ""
                }
            }
        }
    }

    func menuWillOpen(_ menu: NSMenu) { refresh() }

    private func showError(_ message: String) {
        let clean = message.replacingOccurrences(of: "\n", with: " ")
        DispatchQueue.main.async { self.feedback.title = "Error: \(clean.prefix(110))" }
    }

    @objc private func startDev() {
        guard !busy else { return }
        busy = true
        feedback.title = "Starting…"
        DispatchQueue.global(qos: .userInitiated).async {
            // This check prevents duplicate servers and accidental port conflicts.
            if self.health(7676, path: "/healthz").online { self.complete(); return }
            let result = self.manager.start()
            if result.code != 0 { self.showError(result.output.trimmingCharacters(in: .whitespacesAndNewlines)) }
            else {
                // launchctl bootstrap success is not proof that DevSpace has actually started.
                var healthy = false
                for _ in 0..<25 {
                    if self.health(7676, path: "/healthz").online { healthy = true; break }
                    Thread.sleep(forTimeInterval: 0.3)
                }
                if !healthy { self.showError("Managed DevSpace did not become healthy. See ~/Library/Logs/CodasSol-mac-DevSpace.log") }
            }
            self.complete()
        }
    }

    @objc private func stopDev() {
        guard !busy else { return }
        busy = true
        feedback.title = "Stopping…"
        DispatchQueue.global(qos: .userInitiated).async {
            let result = self.manager.stop()
            if result.code != 0 { self.showError(result.output.trimmingCharacters(in: .whitespacesAndNewlines)) }
            self.complete()
        }
    }

    @objc private func diagnoseStartup() {
        guard !busy else { return }
        busy = true
        feedback.title = "Checking…"
        DispatchQueue.global(qos: .userInitiated).async {
            let result = self.manager.diagnostic()
            if result.code != 0 { self.showError(result.output.trimmingCharacters(in: .whitespacesAndNewlines)) }
            else { DispatchQueue.main.async { self.feedback.title = "Startup configuration: ready" } }
            DispatchQueue.main.async { self.busy = false }
        }
    }

    private func complete() {
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) {
            self.busy = false
            if !self.feedback.title.hasPrefix("Error:") { self.feedback.title = "" }
            self.refresh()
        }
    }

    @objc private func quit() { NSApp.terminate(nil) }
}

let application = NSApplication.shared
let delegate = AppDelegate()
application.delegate = delegate
application.run()
