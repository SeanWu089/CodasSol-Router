import AppKit
import Foundation

final class AppDelegate: NSObject, NSApplicationDelegate, NSMenuDelegate {
    private var item: NSStatusItem!
    private let menu = NSMenu()
    private let dev = NSMenuItem(title: "DevSpace: checking…", action: nil, keyEquivalent: "")
    private let router = NSMenuItem(title: "Router: checking…", action: nil, keyEquivalent: "")
    private let start = NSMenuItem(title: "Start DevSpace", action: #selector(startDev), keyEquivalent: "")
    private let stop = NSMenuItem(title: "Stop DevSpace", action: #selector(stopDev), keyEquivalent: "")
    private let feedback = NSMenuItem(title: "", action: nil, keyEquivalent: "")
    private let label = "com.codassol.devspace.menu"
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

    private var agentURL: URL {
        FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/LaunchAgents/\(label).plist")
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
        menu.addItem(start)
        menu.addItem(stop)
        menu.addItem(.separator())
        menu.addItem(feedback)
        menu.addItem(NSMenuItem(title: "Quit menu app", action: #selector(quit), keyEquivalent: "q"))
        menu.items.last?.target = self
        refresh()
        timer = Timer.scheduledTimer(withTimeInterval: 3, repeats: true) { [weak self] _ in self?.refresh() }
    }

    private func alive(_ port: Int, path: String) -> Bool {
        let sem = DispatchSemaphore(value: 0)
        var success = false
        var request = URLRequest(url: URL(string: "http://127.0.0.1:\(port)\(path)")!)
        request.timeoutInterval = 1.5
        URLSession.shared.dataTask(with: request) { data, response, _ in
            if let http = response as? HTTPURLResponse, http.statusCode == 200,
               let data, let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
                success = json["ok"] as? Bool == true
            }
            sem.signal()
        }.resume()
        _ = sem.wait(timeout: .now() + 2)
        return success
    }

    private func launch(_ arguments: [String]) -> (Int32, String) {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/bin/launchctl")
        process.arguments = arguments
        let pipe = Pipe()
        process.standardError = pipe
        process.standardOutput = pipe
        do {
            try process.run()
            process.waitUntilExit()
            let output = String(data: pipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
            return (process.terminationStatus, output)
        } catch { return (-1, error.localizedDescription) }
    }

    private func isManaged() -> Bool {
        launch(["print", "gui/\(getuid())/\(label)"]).0 == 0
    }

    private func refresh() {
        guard !busy else { return }
        DispatchQueue.global(qos: .utility).async {
            let devOK = self.alive(7676, path: "/healthz")
            let routerOK = self.alive(17676, path: "/_codassol/health")
            let managed = self.isManaged()
            DispatchQueue.main.async {
                self.dev.attributedTitle = self.statusText("DevSpace", online: devOK, detail: devOK && !managed ? "Externally started" : "")
                self.router.attributedTitle = self.statusText("Router", online: routerOK)
                self.item.button?.alphaValue = devOK ? 1 : 0.45
                self.start.isEnabled = !devOK
                self.stop.isEnabled = devOK && managed
                if devOK && !managed { self.feedback.title = "DevSpace is running outside this app" }
                else if !self.feedback.title.hasPrefix("Error:") { self.feedback.title = "" }
            }
        }
    }

    func menuWillOpen(_ menu: NSMenu) { refresh() }

    private func showError(_ message: String) {
        DispatchQueue.main.async { self.feedback.title = "Error: \(message.prefix(110))" }
    }

    @objc private func startDev() {
        guard !busy else { return }
        busy = true
        feedback.title = "Starting…"
        DispatchQueue.global(qos: .userInitiated).async {
            if self.alive(7676, path: "/healthz") { self.complete(); return }
            let home = FileManager.default.homeDirectoryForCurrentUser.path
            let executable = "\(home)/.local/npm-global/bin/devspace"
            guard FileManager.default.isExecutableFile(atPath: executable) else {
                self.showError("DevSpace executable missing: \(executable)")
                self.complete(); return
            }
            let log = "\(home)/Library/Logs/CodasSol-DevSpace.log"
            let plist: [String: Any] = [
                "Label": self.label,
                "ProgramArguments": [executable, "serve"],
                "EnvironmentVariables": ["PATH": "\(home)/.local/share/fnm/aliases/default/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"],
                "RunAtLoad": true,
                "KeepAlive": false,
                "StandardOutPath": log,
                "StandardErrorPath": log
            ]
            do {
                let directory = self.agentURL.deletingLastPathComponent()
                try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
                let data = try PropertyListSerialization.data(fromPropertyList: plist, format: .xml, options: 0)
                try data.write(to: self.agentURL, options: .atomic)
            } catch { self.showError(error.localizedDescription); self.complete(); return }
            if self.isManaged() { _ = self.launch(["bootout", "gui/\(getuid())/\(self.label)"]) }
            let result = self.launch(["bootstrap", "gui/\(getuid())", self.agentURL.path])
            if result.0 != 0 { self.showError(result.1.trimmingCharacters(in: .whitespacesAndNewlines)) }
            self.complete()
        }
    }

    @objc private func stopDev() {
        guard !busy else { return }
        busy = true
        feedback.title = "Stopping…"
        DispatchQueue.global(qos: .userInitiated).async {
            guard self.isManaged() else { self.showError("Not a menu-managed process"); self.complete(); return }
            let result = self.launch(["bootout", "gui/\(getuid())/\(self.label)"])
            if result.0 != 0 { self.showError(result.1.trimmingCharacters(in: .whitespacesAndNewlines)) }
            self.complete()
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
