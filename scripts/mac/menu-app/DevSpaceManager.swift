import Foundation
import Darwin

/// Manages only the LaunchAgent created by CodasSol-mac. Never signals an external process.
struct DevSpaceManager {
    let label = "com.codassol.devspace.mac"

    private var home: URL { FileManager.default.homeDirectoryForCurrentUser }
    private var supportDirectory: URL { home.appendingPathComponent("Library/Application Support/CodasSol-mac", isDirectory: true) }
    private var launcher: URL { supportDirectory.appendingPathComponent("devspace-runner.zsh") }
    private var plistURL: URL { home.appendingPathComponent("Library/LaunchAgents/\(label).plist") }
    private var logURL: URL { home.appendingPathComponent("Library/Logs/CodasSol-mac-DevSpace.log") }
    private var domain: String { "gui/\(getuid())" }

    struct CommandResult {
        let code: Int32
        let output: String
    }

    private func command(_ path: String, _ args: [String]) -> CommandResult {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: path)
        p.arguments = args
        let pipe = Pipe()
        p.standardOutput = pipe
        p.standardError = pipe
        do {
            try p.run()
            // launchctl and --diagnose return short output; drain before wait to avoid pipe deadlock.
            let data = pipe.fileHandleForReading.readDataToEndOfFile()
            p.waitUntilExit()
            return CommandResult(code: p.terminationStatus, output: String(decoding: data, as: UTF8.self))
        } catch { return CommandResult(code: -1, output: error.localizedDescription) }
    }

    private func launchctl(_ args: [String]) -> CommandResult {
        command("/bin/launchctl", args)
    }

    func isManaged() -> Bool {
        launchctl(["print", "\(domain)/\(label)"]).code == 0
    }

    func diagnostic() -> CommandResult {
        guard let runner = Bundle.main.path(forResource: "devspace-runner", ofType: "zsh") else {
            return CommandResult(code: -1, output: "Bundled DevSpace launcher is missing. Reinstall CodasSol-mac.")
        }
        return command("/bin/zsh", [runner, "--diagnose"])
    }

    private func installedPlistMatches() -> Bool {
        guard let values = NSDictionary(contentsOf: plistURL) as? [String: Any],
              values["Label"] as? String == label,
              let args = values["ProgramArguments"] as? [String] else { return false }
        return args == ["/bin/zsh", launcher.path, "--serve"]
    }

    private func portIsSafeToBind() -> CommandResult {
        // A failed HTTP health check does NOT imply that TCP/7676 is free.
        // Refuse a second listener rather than racing an external/unhealthy service.
        let listener = command("/usr/sbin/lsof", ["-nP", "-iTCP:7676", "-sTCP:LISTEN"])
        if listener.code == 0 {
            return CommandResult(code: -1, output: "Port 7676 already has a listener. Refusing to start a second DevSpace; inspect the current service first.")
        }
        if listener.code != 1 || !listener.output.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return CommandResult(code: -1, output: "Could not verify whether port 7676 is free: \(listener.output)")
        }
        return CommandResult(code: 0, output: "")
    }

    /// Installs a stable helper path and a self-healing login agent after passing a real preflight.
    /// Only called while local DevSpace is down; never replaces a running service.
    func start() -> CommandResult {
        let check = diagnostic()
        guard check.code == 0 else { return check }
        let portCheck = portIsSafeToBind()
        guard portCheck.code == 0 else { return portCheck }
        guard let source = Bundle.main.url(forResource: "devspace-runner", withExtension: "zsh") else {
            return CommandResult(code: -1, output: "Launcher resource not found")
        }

        if isManaged() {
            // No destructive -k: kickstart is only used to recover a stopped managed service.
            return launchctl(["kickstart", "\(domain)/\(label)"])
        }

        let fm = FileManager.default
        do {
            // Never overwrite an unfamiliar LaunchAgent, even if it has our label.
            if fm.fileExists(atPath: plistURL.path) && !installedPlistMatches() {
                return CommandResult(code: -1, output: "Existing LaunchAgent has an unexpected command. Not overwriting: \(plistURL.path)")
            }
            try fm.createDirectory(at: supportDirectory, withIntermediateDirectories: true)
            try fm.createDirectory(at: plistURL.deletingLastPathComponent(), withIntermediateDirectories: true)
            try fm.createDirectory(at: logURL.deletingLastPathComponent(), withIntermediateDirectories: true)

            // A fixed, app-independent runner survives moving/updating the .app bundle.
            let staged = supportDirectory.appendingPathComponent("devspace-runner-new.zsh")
            if fm.fileExists(atPath: staged.path) { try fm.removeItem(at: staged) }
            try fm.copyItem(at: source, to: staged)
            try fm.setAttributes([.posixPermissions: 0o700], ofItemAtPath: staged.path)
            // rename(2) atomically replaces an old helper, preventing a missing-file window.
            guard rename(staged.path, launcher.path) == 0 else {
                throw NSError(domain: "CodasSol-mac", code: Int(errno), userInfo: [NSLocalizedDescriptionKey: "Atomic launcher update failed: \(String(cString: strerror(errno)))"])
            }

            let plist: [String: Any] = [
                "Label": label,
                "ProgramArguments": ["/bin/zsh", launcher.path, "--serve"],
                "WorkingDirectory": home.path,
                "EnvironmentVariables": ["PATH": "\(home.path)/.local/share/fnm/aliases/default/bin:\(home.path)/.local/npm-global/bin:\(home.path)/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"],
                "RunAtLoad": true,
                "KeepAlive": ["SuccessfulExit": false],
                "ThrottleInterval": 15,
                "StandardOutPath": logURL.path,
                "StandardErrorPath": logURL.path
            ]
            let data = try PropertyListSerialization.data(fromPropertyList: plist, format: .xml, options: 0)
            try data.write(to: plistURL, options: .atomic)
        } catch {
            return CommandResult(code: -1, output: "Could not prepare managed DevSpace: \(error.localizedDescription)")
        }

        let launched = launchctl(["bootstrap", domain, plistURL.path])
        if launched.code != 0 {
            return CommandResult(code: launched.code, output: "launchctl bootstrap: \(launched.output)\nLog: \(logURL.path)")
        }
        return launched
    }

    func stop() -> CommandResult {
        guard isManaged(), installedPlistMatches() else {
            return CommandResult(code: -1, output: "This DevSpace service is external or its config is unrecognized; refusing to stop it.")
        }
        return launchctl(["bootout", "\(domain)/\(label)"])
    }
}
