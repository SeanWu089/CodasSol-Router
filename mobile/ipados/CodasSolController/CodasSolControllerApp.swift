import SwiftUI

@main
struct CodasSolControllerApp: App {
    @StateObject private var hub = ControllerHub()

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environmentObject(hub)
        }
    }
}
