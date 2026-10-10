import Foundation

@main
struct DevicePanelClientTest {
    static func main() async throws {
        guard CommandLine.arguments.count == 4,
              let livePort = Int(CommandLine.arguments[1]),
              let oldPort = Int(CommandLine.arguments[2]) else { fatalError("Expected fixture ports and state path") }
        let state = URL(fileURLWithPath: CommandLine.arguments[3])
        let api = DeviceDirectoryClient(routerPort: livePort, stateFile: state)
        let legacy = api.legacyRegistrations()
        precondition(legacy.count == 2)
        precondition(legacy.contains(where: { $0.id == "legacy-win" && $0.kind == "agent" }))
        precondition(legacy.contains(where: { $0.id == "peer-win" && $0.kind == "router" }))
        precondition(legacy.allSatisfy { $0.status == "unknown" && !$0.online })
        print("PASS: legacy Agent and Peer registrations both visible with unknown status")
        let devices = try await api.devices()
        precondition(devices.count == 2)
        precondition(devices[0].id == "mac-id" && devices[0].isThisDevice)
        precondition(devices[1].id == "win-id" && devices[1].status == "offline")
        let sync = try await api.rename(id: "win-id", to: "Home GPU")
        precondition(sync.attempted == 2 && sync.delivered == 1)
        print("PASS: valid schema, local-first sorting, offline presence, rename delivery count")

        let old = DeviceDirectoryClient(routerPort: oldPort, stateFile: state)
        do { _ = try await old.devices(); fatalError("Old Router incorrectly accepted") }
        catch DirectoryFailure.notInstalled { print("PASS: missing Registry endpoint reported as not installed") }

        let missing = DeviceDirectoryClient(routerPort: livePort,
                                            stateFile: URL(fileURLWithPath: state.path + ".missing"))
        do { _ = try await missing.devices(); fatalError("Missing auth token incorrectly accepted") }
        catch DirectoryFailure.noAdminToken { print("PASS: missing admin credential fails closed") }

        let wrong = URL(fileURLWithPath: state.path + ".wrong")
        try Data("{\"adminToken\":\"\(String(repeating: "x", count: 40))\"}".utf8).write(to: wrong)
        let unauthorized = DeviceDirectoryClient(routerPort: livePort, stateFile: wrong)
        do { _ = try await unauthorized.devices(); fatalError("Wrong admin credential incorrectly accepted") }
        catch DirectoryFailure.unauthorized { print("PASS: invalid admin credential rejected") }
    }
}
