import Foundation
import Combine
import Security
import UIKit

struct RouterProfile: Codable, Identifiable, Hashable {
    let id: UUID
    var name: String
    var address: String
    var allowInsecureHTTP: Bool
}

struct NodeSnapshot: Decodable {
    let protocolVersion: Int
    let routerDeviceId: String
    let observedAt: Double
    let devices: [RemoteNode]

    enum CodingKeys: String, CodingKey {
        case routerDeviceId, observedAt, devices
        case protocolVersion = "protocol"
    }
}

struct RemoteNode: Decodable {
    let id: String
    let label: String
    let platform: String
    let kind: String
    let online: Bool
    let connectionOnline: Bool
    let backendReachable: Bool?
    let lastSeenAt: Double?
}

enum DevicePresence: String {
    case online
    case offline
    case unverified

    var text: String {
        switch self {
        case .online: return "在线"
        case .offline: return "离线"
        case .unverified: return "当前无法验证"
        }
    }
}

struct VisibleNode: Identifiable {
    let id: String
    let deviceID: String
    let label: String
    let platform: String
    let kind: String
    let presence: DevicePresence
    let backendReachable: Bool?
    let lastSeenAt: Double?
    let observedVia: [String]
    let notes: [String]
}

enum ControllerError: LocalizedError {
    case invalidAddress(String)
    case insecureHTTP
    case duplicateRouter
    case missingCredential
    case http(Int, String)
    case badResponse
    case keychain(Int32)

    var errorDescription: String? {
        switch self {
        case .invalidAddress(let value): return "无效的 Router 地址：\(value)"
        case .insecureHTTP: return "HTTP 只能用于已手动允许的可信局域网地址；公网必须使用 HTTPS。"
        case .duplicateRouter: return "这个 Router 已添加。"
        case .missingCredential: return "本机安全存储中找不到控制端凭据，请重新配对。"
        case .http(let code, let detail): return "Router 返回 HTTP \(code)：\(detail)"
        case .badResponse: return "Router 返回了无法解析的数据，可能尚未安装控制端接口。"
        case .keychain(let code): return "iPad Keychain 保存失败（\(code)）。"
        }
    }
}

private enum SecretStore {
    static let service = "dev.codassol.controller.token"

    static func write(_ token: String, for id: UUID) throws {
        let account = id.uuidString
        let selector: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account
        ]
        SecItemDelete(selector as CFDictionary)
        var query = selector
        query[kSecValueData as String] = Data(token.utf8)
        query[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        let result = SecItemAdd(query as CFDictionary, nil)
        guard result == errSecSuccess else { throw ControllerError.keychain(result) }
    }

    static func read(for id: UUID) throws -> String {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: id.uuidString,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne
        ]
        var result: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess,
              let data = result as? Data,
              let token = String(data: data, encoding: .utf8) else {
            throw ControllerError.missingCredential
        }
        return token
    }

    static func delete(for id: UUID) {
        SecItemDelete([
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: id.uuidString
        ] as CFDictionary)
    }
}

private struct EnrollmentReply: Decodable {
    let deviceId: String
    let controllerToken: String
}

private struct ErrorReply: Decodable {
    let error: String?
    let message: String?
}

// Pairing and device requests must stay at the explicitly configured endpoint.
private final class RejectRedirects: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask,
                    willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest,
                    completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}

private enum ControllerNetwork {
    private static let session = URLSession(configuration: .ephemeral,
                                            delegate: RejectRedirects(), delegateQueue: nil)

    static func normalizedAddress(_ input: String, allowHTTP: Bool) throws -> String {
        let trimmed = input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard var url = URLComponents(string: trimmed),
              let scheme = url.scheme?.lowercased(),
              let host = url.host, !host.isEmpty,
              url.user == nil, url.password == nil,
              url.query == nil, url.fragment == nil,
              url.path == "" || url.path == "/",
              ["http", "https"].contains(scheme),
              url.port == nil || (1...65535).contains(url.port!) else {
            throw ControllerError.invalidAddress(trimmed)
        }
        // HTTP is an explicit LAN-only escape hatch. Public hosts must use HTTPS.
        // This check is identical in Debug and Release so a sideload build can
        // connect to the user's trusted LAN without allowing public HTTP endpoints.
        if scheme == "http" && (!allowHTTP || !RouterAddressPolicy.isPrivateHost(host)) {
            throw ControllerError.insecureHTTP
        }
        url.scheme = scheme
        url.host = host.lowercased()
        url.path = ""
        guard let normalized = url.string, url.url != nil else {
            throw ControllerError.invalidAddress(trimmed)
        }
        return normalized
    }

    static func request<T: Decodable>(
        profile: RouterProfile,
        path: String,
        token: String,
        method: String = "GET",
        json: Data? = nil
    ) async throws -> T {
        let address = try normalizedAddress(profile.address, allowHTTP: profile.allowInsecureHTTP)
        guard let url = URL(string: address + path) else {
            throw ControllerError.invalidAddress(profile.address)
        }
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.timeoutInterval = 7
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if let json {
            request.httpBody = json
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw ControllerError.badResponse }
        guard (200..<300).contains(http.statusCode) else {
            let error = try? JSONDecoder().decode(ErrorReply.self, from: data)
            throw ControllerError.http(http.statusCode, error?.message ?? error?.error ?? "请求失败")
        }
        do { return try JSONDecoder().decode(T.self, from: data) }
        catch { throw ControllerError.badResponse }
    }
}

@MainActor
final class ControllerHub: ObservableObject {
    @Published private(set) var routers: [RouterProfile] = []
    @Published private(set) var nodes: [VisibleNode] = []
    @Published private(set) var routerReachable: [UUID: Bool] = [:]
    @Published private(set) var routerErrors: [UUID: String] = [:]
    @Published private(set) var refreshing = false
    @Published private(set) var lastRefreshed: Date?

    let localName = UIDevice.current.name
    private let routerKey = "codassol.controller.routers.v1"
    private let controllerIDKey = "codassol.controller.identity.v1"
    private var cachedSnapshots: [UUID: NodeSnapshot] = [:]
    private var requestInFlight = false

    var localID: String {
        if let old = UserDefaults.standard.string(forKey: controllerIDKey) { return old }
        let new = "controller-" + UUID().uuidString.lowercased()
        UserDefaults.standard.set(new, forKey: controllerIDKey)
        return new
    }

    init() {
        if let bytes = UserDefaults.standard.data(forKey: routerKey),
           let profiles = try? JSONDecoder().decode([RouterProfile].self, from: bytes) {
            routers = profiles
        }
    }

    private func persist() {
        if let bytes = try? JSONEncoder().encode(routers) {
            UserDefaults.standard.set(bytes, forKey: routerKey)
        }
    }

    func addRouter(name: String, address: String, pairingToken: String, allowHTTP: Bool) async throws {
        let cleanAddress = try ControllerNetwork.normalizedAddress(address, allowHTTP: allowHTTP)
        guard !routers.contains(where: { $0.address.caseInsensitiveCompare(cleanAddress) == .orderedSame })
        else { throw ControllerError.duplicateRouter }
        let profile = RouterProfile(id: UUID(), name: name.isEmpty ? "CodasSol Router" : name,
                                    address: cleanAddress, allowInsecureHTTP: allowHTTP)
        let payload = try JSONSerialization.data(withJSONObject: [
            "deviceId": localID, "label": localName
        ])
        let reply: EnrollmentReply = try await ControllerNetwork.request(
            profile: profile, path: "/_codassol/controller/enroll",
            token: pairingToken.trimmingCharacters(in: .whitespacesAndNewlines),
            method: "POST", json: payload
        )
        guard reply.deviceId == localID else { throw ControllerError.badResponse }
        try SecretStore.write(reply.controllerToken, for: profile.id)
        routers.append(profile)
        persist()
        await refresh()
    }

    func removeRouter(_ id: UUID) {
        SecretStore.delete(for: id)
        routers.removeAll { $0.id == id }
        cachedSnapshots.removeValue(forKey: id)
        routerReachable.removeValue(forKey: id)
        routerErrors.removeValue(forKey: id)
        persist()
        rebuildNodes()
    }

    func refresh() async {
        guard !requestInFlight else { return }
        requestInFlight = true
        refreshing = true
        defer { refreshing = false; requestInFlight = false }
        for profile in routers {
            do {
                let token = try SecretStore.read(for: profile.id)
                let reply: NodeSnapshot = try await ControllerNetwork.request(
                    profile: profile, path: "/_codassol/controller/devices", token: token
                )
                guard reply.protocolVersion == 1 else { throw ControllerError.badResponse }
                cachedSnapshots[profile.id] = reply
                routerReachable[profile.id] = true
                routerErrors.removeValue(forKey: profile.id)
            } catch {
                routerReachable[profile.id] = false
                routerErrors[profile.id] = error.localizedDescription
            }
        }
        lastRefreshed = Date()
        rebuildNodes()
    }

    private func rebuildNodes() {
        struct Sighting {
            let node: RemoteNode
            let source: String
            let verified: Bool
        }
        var sightings: [String: [Sighting]] = [:]
        for profile in routers {
            guard let snapshot = cachedSnapshots[profile.id] else { continue }
            let verified = routerReachable[profile.id] == true
            for node in snapshot.devices where node.id != localID {
                let key = node.platform + ":" + node.id
                sightings[key, default: []].append(Sighting(
                    node: node, source: profile.name, verified: verified
                ))
            }
        }
        nodes = sightings.map { key, found in
            let candidates = found.filter(\.verified)
            let active = candidates.first(where: { $0.node.online }) ?? candidates.first
            let chosen = active ?? found[0]
            let state: DevicePresence = candidates.isEmpty ? .unverified :
                (candidates.contains(where: { $0.node.online }) ? .online : .offline)
            let reachability = candidates.first(where: { $0.node.online })?.node.backendReachable
                ?? active?.node.backendReachable
            return VisibleNode(
                id: key, deviceID: chosen.node.id, label: chosen.node.label,
                platform: chosen.node.platform, kind: chosen.node.kind,
                presence: state, backendReachable: reachability,
                lastSeenAt: chosen.node.lastSeenAt,
                observedVia: Array(Set(found.map(\.source))).sorted(),
                notes: found.filter { !$0.verified }.map { "\($0.source)：Router 当前不可达" }
            )
        }.sorted { left, right in
            let order: [DevicePresence: Int] = [.online: 0, .offline: 1, .unverified: 2]
            if order[left.presence] != order[right.presence] {
                return order[left.presence, default: 3] < order[right.presence, default: 3]
            }
            return left.label.localizedStandardCompare(right.label) == .orderedAscending
        }
    }
}
