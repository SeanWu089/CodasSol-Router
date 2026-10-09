import Foundation

@main
struct RouterAddressPolicyTests {
    static func main() {
        let allowed = ["localhost", "mac.local", "192.168.1.10", "10.0.0.2", "172.16.0.1",
                       "172.31.255.254", "169.254.1.2", "127.0.0.1", "::1", "[fd12::1]",
                       "fc00::1", "fe80::1", "febf::1", "::ffff:192.168.1.10"]
        let denied = ["fd.example.com", "fc.example.com", "example.com", "fd", "fd12::oops",
                      "192.168.999.1", "010.0.0.1", "172.15.0.1", "172.32.0.1", "8.8.8.8",
                      "192.168.1.10.example.com", "2001:db8::1", "::", "fec0::1", "::ffff:8.8.8.8",
                      "::ffff:010.0.0.1"]
        for host in allowed {
            precondition(RouterAddressPolicy.isPrivateHost(host), "Expected a local address: \(host)")
        }
        for host in denied {
            precondition(!RouterAddressPolicy.isPrivateHost(host), "Unexpected HTTP allowance: \(host)")
        }
        print("Router address policy: \(allowed.count + denied.count) cases passed")
    }
}
