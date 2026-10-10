import Foundation

struct DirectoryResponse: Decodable {
    let version: Int
    let localDeviceId: String
    let devices: [DeviceInfo]
}

struct DeviceInfo: Decodable, Identifiable {
    let id: String
    let installationId: String?
    let name: String
    let platform: String
    let kind: String
    let isThisDevice: Bool
    let status: String
    let online: Bool
    let backendReachable: Bool
    let lastSeenAt: Double?

    static func localFallback(connected: Bool, backend: Bool) -> DeviceInfo {
        DeviceInfo(id: "__local_preview__", installationId: nil,
                   name: Host.current().localizedName ?? "This Mac", platform: "darwin",
                   kind: "router", isThisDevice: true,
                   status: !connected ? "offline" : backend ? "online" : "degraded",
                   online: connected && backend, backendReachable: backend,
                   lastSeenAt: nil)
    }

    func withUnknownStatus() -> DeviceInfo {
        DeviceInfo(id: id, installationId: installationId, name: name,
                   platform: platform, kind: kind, isThisDevice: isThisDevice,
                   status: "unknown", online: false, backendReachable: false,
                   lastSeenAt: lastSeenAt)
    }
}

struct RouterHealth {
    let connected: Bool
    let backendReachable: Bool
}

enum DirectoryFailure: Error, LocalizedError {
    case notInstalled
    case noAdminToken
    case unauthorized
    case invalidReply
    case serviceUnavailable
    case requestFailed(String)

    var errorDescription: String? {
        switch self {
        case .notInstalled: return "Device Registry is not yet installed on this Router."
        case .noAdminToken: return "Local Router has no device-directory admin token yet."
        case .unauthorized: return "The Router rejected the local admin token."
        case .invalidReply: return "Invalid device directory response."
        case .serviceUnavailable: return "Local Router is unreachable."
        case .requestFailed(let message): return message
        }
    }
}

/// All catalog requests are loopback-only; never forwards an admin bearer to remote peers.
struct DeviceDirectoryClient {
    private let base: URL
    private let stateFile: URL

    init(routerPort: Int = 17676, stateFile: URL? = nil) {
        base = URL(string: "http://127.0.0.1:\(routerPort)")!
        self.stateFile = stateFile ?? FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".codassol/router.json")
    }

    private func adminToken() throws -> String {
        guard let data = try? Data(contentsOf: stateFile),
              let record = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let token = record["adminToken"] as? String, token.count >= 32 else {
            throw DirectoryFailure.noAdminToken
        }
        return token
    }

    /// Read only display metadata from legacy Agent *and Peer* registrations.
    /// Neither source stores trustworthy freshness, so status MUST be unknown.
    func legacyRegistrations() -> [DeviceInfo] {
        let state = ((try? Data(contentsOf: stateFile)).flatMap {
            try? JSONSerialization.jsonObject(with: $0) as? [String: Any]
        }) ?? [:]
        let agents = state["agents"] as? [String: [String: Any]] ?? [:]
        var entries: [String: DeviceInfo] = [:]
        for (id, record) in agents {
            guard !id.isEmpty, id.count <= 128 else { continue }
            let label = record["label"] as? String ?? id
            let platform = record["platform"] as? String ?? "unknown"
            entries[id] = DeviceInfo(id: id, installationId: nil,
                              name: label.isEmpty ? id : label, platform: platform,
                              kind: "agent", isThisDevice: false, status: "unknown",
                              online: false, backendReachable: false, lastSeenAt: nil)
        }
        let peersPath = stateFile.deletingLastPathComponent().appendingPathComponent("peers.json")
        if let data = try? Data(contentsOf: peersPath),
           let peers = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]] {
            for peer in peers {
                guard let id = peer["id"] as? String, !id.isEmpty, id.count <= 128,
                      entries[id] == nil else { continue }
                let label = peer["label"] as? String ?? id
                entries[id] = DeviceInfo(id: id, installationId: nil,
                    name: label.isEmpty ? id : label,
                    platform: peer["platform"] as? String ?? "unknown", kind: "router",
                    isThisDevice: false, status: "unknown", online: false,
                    backendReachable: false, lastSeenAt: nil)
            }
        }
        return entries.values.sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
    }

    private func fetch(_ endpoint: String, method: String = "GET", payload: Data? = nil) async throws -> Data {
        let url = URL(string: endpoint, relativeTo: base)!.absoluteURL
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.timeoutInterval = 3
        request.setValue("Bearer \(try adminToken())", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if let payload {
            request.httpBody = payload
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw DirectoryFailure.invalidReply }
        switch http.statusCode {
        case 200: return data
        case 401, 403: throw DirectoryFailure.unauthorized
        case 404: throw DirectoryFailure.notInstalled
        default: throw DirectoryFailure.requestFailed("Device Registry HTTP \(http.statusCode)")
        }
    }

    func devices() async throws -> [DeviceInfo] {
        let data = try await fetch("/_codassol/devices")
        let result = try JSONDecoder().decode(DirectoryResponse.self, from: data)
        guard result.version == 1, result.devices.contains(where: { $0.id == result.localDeviceId && $0.isThisDevice }) else {
            throw DirectoryFailure.invalidReply
        }
        return result.devices.sorted {
            if $0.isThisDevice != $1.isThisDevice { return $0.isThisDevice }
            return $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending
        }
    }

    func rename(id: String, to name: String) async throws -> (attempted: Int, delivered: Int) {
        let valid = CharacterSet.urlPathAllowed.subtracting(CharacterSet(charactersIn: "/?#%"))
        guard let escaped = id.addingPercentEncoding(withAllowedCharacters: valid) else {
            throw DirectoryFailure.requestFailed("Invalid device identifier")
        }
        let json = try JSONSerialization.data(withJSONObject: ["name": name])
        let data = try await fetch("/_codassol/devices/\(escaped)", method: "PATCH", payload: json)
        guard let object = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              object["ok"] as? Bool == true else { throw DirectoryFailure.invalidReply }
        let sync = object["sync"] as? [String: Any] ?? [:]
        return (sync["attempted"] as? Int ?? 0, sync["delivered"] as? Int ?? 0)
    }

    func health(port: Int, path: String) async -> RouterHealth {
        guard let url = URL(string: "http://127.0.0.1:\(port)\(path)") else {
            return RouterHealth(connected: false, backendReachable: false)
        }
        var request = URLRequest(url: url)
        request.timeoutInterval = 2
        do {
            let (data, response) = try await URLSession.shared.data(for: request)
            guard (response as? HTTPURLResponse)?.statusCode == 200,
                  let json = try JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let ok = json["ok"] as? Bool, ok else {
                return RouterHealth(connected: false, backendReachable: false)
            }
            return RouterHealth(connected: true,
                                backendReachable: json["backendReachable"] as? Bool ?? true)
        } catch {
            return RouterHealth(connected: false, backendReachable: false)
        }
    }
}
