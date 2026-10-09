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

        var ipv4 = in_addr()
        if host.withCString({ inet_pton(AF_INET, $0, &ipv4) }) == 1 {
            return withUnsafeBytes(of: ipv4) { isPrivateIPv4(Array($0)) }
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

    private static func isPrivateIPv4(_ bytes: [UInt8]) -> Bool {
        bytes[0] == 10 || bytes[0] == 127 ||
            (bytes[0] == 192 && bytes[1] == 168) ||
            (bytes[0] == 172 && (16...31).contains(bytes[1])) ||
            (bytes[0] == 169 && bytes[1] == 254)
    }
}
