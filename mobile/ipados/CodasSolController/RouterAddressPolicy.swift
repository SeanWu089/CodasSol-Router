import Foundation
#if canImport(Darwin)
import Darwin
#else
import Glibc
#endif

enum RouterAddressPolicy {
    static func isPrivateHost(_ rawHost: String) -> Bool {
        let host = rawHost.lowercased().trimmingCharacters(in: CharacterSet(charactersIn: "[]"))
        if host == "localhost" || (host.hasSuffix(".local") && host.count > 6) { return true }

        if !host.contains(":") {
            guard let bytes = parseIPv4(host) else { return false }
            return isPrivateIPv4(bytes)
        }
        if host.contains(".") {
            guard let tail = host.split(separator: ":").last,
                  parseIPv4(String(tail)) != nil else { return false }
        }

        // Parse IPv6 before examining its prefix: fd.example.com is a public
        // hostname, not a Unique Local Address merely because it starts in fd.
        var ipv6 = in6_addr()
        guard host.withCString({ inet_pton(AF_INET6, $0, &ipv6) }) == 1 else { return false }
        let bytes = withUnsafeBytes(of: ipv6) { Array($0) }
        if bytes.prefix(15).allSatisfy({ $0 == 0 }) && bytes[15] == 1 { return true }
        if bytes[0] & 0xfe == 0xfc { return true } // fc00::/7
        if bytes[0] == 0xfe && bytes[1] & 0xc0 == 0x80 { return true } // fe80::/10
        if bytes.prefix(10).allSatisfy({ $0 == 0 }) && bytes[10] == 0xff && bytes[11] == 0xff {
            return isPrivateIPv4(Array(bytes.suffix(4)))
        }
        return false
    }

    private static func parseIPv4(_ host: String) -> [UInt8]? {
        let parts = host.split(separator: ".", omittingEmptySubsequences: false)
        guard parts.count == 4, parts.allSatisfy({ part in
            !part.isEmpty && part.utf8.allSatisfy({ (48...57).contains($0) }) &&
                (part.count == 1 || part.first != "0")
        }) else { return nil }
        let bytes = parts.compactMap { UInt8($0) }
        return bytes.count == 4 ? bytes : nil
    }

    private static func isPrivateIPv4(_ bytes: [UInt8]) -> Bool {
        bytes[0] == 10 || bytes[0] == 127 ||
            (bytes[0] == 192 && bytes[1] == 168) ||
            (bytes[0] == 172 && (16...31).contains(bytes[1])) ||
            (bytes[0] == 169 && bytes[1] == 254)
    }
}
