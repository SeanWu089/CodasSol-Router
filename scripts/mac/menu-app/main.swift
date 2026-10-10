import AppKit
import SwiftUI

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    private var statusItem: NSStatusItem!
    private let popover = NSPopover()
    private let model = DevicePanelModel()
    private var timer: Timer?

    private func setStatusIcon() {
        if let path = Bundle.main.path(forResource: "SeanTemplate", ofType: "png"),
           let icon = NSImage(contentsOfFile: path) {
            icon.size = NSSize(width: 21, height: 21)
            icon.isTemplate = true
            statusItem.button?.image = icon
            statusItem.button?.imagePosition = .imageOnly
        } else {
            statusItem.button?.title = "◈"
        }
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        statusItem.button?.title = "◈"
        statusItem.button?.toolTip = "CodasSol · Devices"
        setStatusIcon()
        statusItem.button?.target = self
        statusItem.button?.action = #selector(togglePanel(_:))

        popover.behavior = .transient
        popover.animates = true
        popover.contentViewController = NSHostingController(rootView: DevicePanelView(model: model))
        model.onStatusChange = { [weak self] connected in
            self?.statusItem.button?.alphaValue = connected ? 1.0 : 0.45
        }
        Task { await model.refresh() }
        timer = Timer.scheduledTimer(withTimeInterval: 8, repeats: true) { [weak self] _ in
            guard let self else { return }
            Task { await self.model.refresh() }
        }
    }

    @objc private func togglePanel(_ sender: NSStatusBarButton) {
        if popover.isShown {
            popover.performClose(sender)
        } else {
            popover.show(relativeTo: sender.bounds, of: sender, preferredEdge: .minY)
            NSApp.activate(ignoringOtherApps: true)
            Task { await model.refresh() }
        }
    }
}

MainActor.assumeIsolated {
    let application = NSApplication.shared
    let delegate = AppDelegate()
    application.delegate = delegate
    application.run()
}
