import AppKit
import Foundation
import SwiftUI

@MainActor
final class DevicePanelModel: ObservableObject {
    @Published private(set) var devices: [DeviceInfo] = []
    @Published private(set) var directoryMessage = ""
    @Published private(set) var canRenameDevices = false
    @Published private(set) var lastUpdated: Date?
    @Published private(set) var devspace = RouterHealth(connected: false, backendReachable: false)
    @Published private(set) var router = RouterHealth(connected: false, backendReachable: false)
    @Published private(set) var devspaceManaged = false
    @Published var selectedDeviceID: String?
    @Published var renameText = ""
    @Published var actionMessage = ""
    @Published var busy = false
    @Published var loading = false
    @Published var confirmStop = false

    private let client = DeviceDirectoryClient()
    private let manager = DevSpaceManager()
    var onStatusChange: ((Bool) -> Void)?

    var local: DeviceInfo {
        devices.first(where: { $0.isThisDevice }) ??
            .localFallback(connected: router.connected, backend: router.backendReachable)
    }

    var others: [DeviceInfo] { devices.filter { !$0.isThisDevice } }
    var selected: DeviceInfo? {
        guard let selectedDeviceID else { return nil }
        return devices.first(where: { $0.id == selectedDeviceID }) ??
            (selectedDeviceID == "__local_preview__" ? local : nil)
    }

    func choose(_ device: DeviceInfo) {
        selectedDeviceID = device.id
        renameText = device.name
        actionMessage = ""
    }

    func refresh() async {
        guard !loading else { return }
        loading = true
        defer { loading = false }
        async let dev = client.health(port: 7676, path: "/healthz")
        async let routerStatus = client.health(port: 17676, path: "/_codassol/health")
        devspace = await dev
        router = await routerStatus
        onStatusChange?(devspace.connected && router.connected && router.backendReachable)
        devspaceManaged = await Task.detached(priority: .utility) {
            DevSpaceManager().ownsRunningDevSpace()
        }.value

        if !router.connected {
            devices = devices.filter { !$0.isThisDevice }.map { $0.withUnknownStatus() }
            canRenameDevices = false
            lastUpdated = nil
            directoryMessage = "Router unavailable"
            return
        }

        do {
            let live = try await client.devices()
            devices = live
            canRenameDevices = true
            lastUpdated = Date()
            directoryMessage = ""
        } catch DirectoryFailure.noAdminToken {
            devices = client.legacyRegistrations()
            canRenameDevices = false
            lastUpdated = nil
            directoryMessage = ""
        } catch DirectoryFailure.notInstalled {
            devices = client.legacyRegistrations()
            canRenameDevices = false
            lastUpdated = nil
            directoryMessage = ""
        } catch DirectoryFailure.unauthorized {
            devices = []
            canRenameDevices = false
            lastUpdated = nil
            directoryMessage = "Device list unavailable"
        } catch {
            devices = devices.filter { !$0.isThisDevice }.map { $0.withUnknownStatus() }
            canRenameDevices = false
            lastUpdated = nil
            directoryMessage = "Device status unavailable"
        }
    }

    func saveName() async {
        guard let device = selected else { return }
        guard canRenameDevices else { return }
        let next = renameText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !next.isEmpty, next.count <= 80, !next.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }) else {
            actionMessage = "Name must contain 1–80 printable characters."
            return
        }
        busy = true
        defer { busy = false }
        do {
            let result = try await client.rename(id: device.id, to: next)
            actionMessage = result.delivered < result.attempted
                ? "Saved locally · syncing other devices when reachable"
                : "Name saved · \(result.delivered) peer(s) notified"
            await refresh()
        } catch {
            actionMessage = error.localizedDescription
        }
    }

    func controlDevSpace(start: Bool) async {
        guard !busy else { return }
        busy = true
        actionMessage = start ? "Starting DevSpace…" : "Stopping DevSpace…"
        let result = await Task.detached(priority: .userInitiated) { () -> DevSpaceManager.CommandResult in
            let manager = DevSpaceManager()
            return start ? manager.start() : manager.stop()
        }.value
        actionMessage = result.code == 0
            ? (start ? "Start requested · checking health…" : "Stop requested")
            : "Operation failed: \(result.output.prefix(140))"
        busy = false
        await refresh()
    }

    func diagnose() async {
        guard !busy else { return }
        busy = true
        let result = await Task.detached(priority: .userInitiated) {
            DevSpaceManager().diagnostic()
        }.value
        actionMessage = result.code == 0 ? "Startup configuration verified" :
            "Diagnostic failed: \(result.output.prefix(140))"
        busy = false
    }
}

private func statusColor(_ severity: DeviceInfo.DisplaySeverity) -> Color {
    switch severity {
    case .ready: return .green
    case .caution: return .orange
    case .offline: return .gray
    case .unknown: return .secondary
    }
}

struct DevicePanelView: View {
    @ObservedObject var model: DevicePanelModel

    private func sectionTitle(_ title: String) -> some View {
        Text(title).font(.system(size: 10, weight: .semibold))
            .foregroundColor(.secondary)
            .tracking(1.2)
            .padding(.horizontal, 17)
            .padding(.top, 15)
            .padding(.bottom, 6)
    }

    private func deviceRow(_ device: DeviceInfo) -> some View {
        Button {
            model.choose(device)
        } label: {
            HStack(spacing: 11) {
                Image(systemName: device.platform == "android" ? "iphone" : "laptopcomputer")
                    .font(.system(size: 16, weight: .regular))
                    .foregroundColor(.secondary)
                    .frame(width: 27)
                VStack(alignment: .leading, spacing: 3) {
                    Text(device.name).font(.system(size: 13, weight: .medium))
                        .lineLimit(1)
                    if device.isThisDevice { Text("This device").font(.system(size: 10)).foregroundColor(.secondary) }
                }
                Spacer(minLength: 6)
                Circle().fill(statusColor(device.displaySeverity)).frame(width: 7, height: 7)
                Text(device.displayTitle)
                    .font(.system(size: 11)).foregroundColor(.secondary)
                Image(systemName: "chevron.right")
                    .font(.system(size: 9, weight: .semibold)).foregroundColor(.secondary)
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 10)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    private var directoryNotice: some View {
        VStack(alignment: .leading, spacing: 7) {
            HStack(spacing: 8) {
                Image(systemName: "info.circle").foregroundColor(.secondary)
                Text(model.directoryMessage)
            }
            .font(.system(size: 11))
            .foregroundColor(.secondary)
            .fixedSize(horizontal: false, vertical: true)
        }
        .padding(.horizontal, 18)
        .padding(.vertical, 13)
    }

    private var listing: some View {
        VStack(alignment: .leading, spacing: 0) {
            sectionTitle("THIS DEVICE")
            deviceRow(model.local)
            Divider().padding(.horizontal, 16).padding(.top, 7)
            sectionTitle("OTHER DEVICES")
            if model.others.isEmpty && model.directoryMessage.isEmpty {
                Text("No other registered devices yet")
                    .font(.system(size: 12)).foregroundColor(.secondary)
                    .padding(.horizontal, 18).padding(.vertical, 12)
            } else {
                ForEach(model.others) { device in deviceRow(device) }
            }
            if !model.directoryMessage.isEmpty { directoryNotice }
        }
    }

    private var detail: some View {
        VStack(alignment: .leading, spacing: 13) {
            if let device = model.selected {
                HStack(spacing: 10) {
                    Button { model.selectedDeviceID = nil; model.actionMessage = "" } label: {
                        Image(systemName: "chevron.left")
                    }.buttonStyle(.plain)
                    Text(device.name).font(.system(size: 15, weight: .semibold)).lineLimit(1)
                    Spacer()
                    Circle().fill(statusColor(device.displaySeverity)).frame(width: 8, height: 8)
                    Text(device.displayTitle).font(.system(size: 11)).foregroundColor(.secondary)
                }
                if model.canRenameDevices && device.id != "__local_preview__" {
                    VStack(alignment: .leading, spacing: 5) {
                        Text("DEVICE NAME").font(.system(size: 10, weight: .semibold)).foregroundColor(.secondary)
                        HStack {
                            TextField("Device name", text: $model.renameText)
                                .textFieldStyle(.roundedBorder)
                                .onSubmit { Task { await model.saveName() } }
                            Button("Save") { Task { await model.saveName() } }
                                .disabled(model.busy)
                        }
                    }
                }
                VStack(alignment: .leading, spacing: 6) {
                    information("Platform", device.platform)
                    information("Device ID", device.id)
                    if let identity = device.installationId { information("Installation", identity) }
                    information("Backend", device.backendTitle)
                    information("Execution", device.executionTitle)
                    if let last = device.lastSeenAt {
                        information("Last seen", Date(timeIntervalSince1970: last / 1000).formatted())
                    }
                }.font(.system(size: 11))
                if device.isThisDevice {
                    Divider()
                    HStack {
                        Text("DevSpace").font(.system(size: 12, weight: .medium))
                        Spacer()
                        Text(model.devspace.connected ? "Running" : "Stopped")
                            .foregroundColor(model.devspace.connected ? .green : .secondary)
                        Text(model.devspaceManaged ? "· Managed" : "· External")
                            .foregroundColor(.secondary)
                    }
                    HStack {
                        Text("Router").font(.system(size: 12, weight: .medium))
                        Spacer()
                        Text(model.router.connected ? "Running" : "Offline")
                            .foregroundColor(model.router.connected ? .green : .secondary)
                    }
                    HStack {
                        Button("Start") { Task { await model.controlDevSpace(start: true) } }
                            .disabled(model.busy || model.devspace.connected)
                        Button("Stop") { model.confirmStop = true }
                            .disabled(model.busy || !model.devspace.connected || !model.devspaceManaged)
                        Spacer()
                        Button("Diagnose") { Task { await model.diagnose() } }
                            .disabled(model.busy)
                    }
                    .alert("Stop local DevSpace?", isPresented: $model.confirmStop) {
                        Button("Cancel", role: .cancel) { }
                        Button("Stop and disconnect", role: .destructive) {
                            Task { await model.controlDevSpace(start: false) }
                        }
                    } message: {
                        Text("This may disconnect CodasSol MCP until DevSpace is restarted. Router will not be stopped.")
                    }
                }
                if !model.actionMessage.isEmpty {
                    Text(model.actionMessage).font(.system(size: 11))
                        .foregroundColor(.secondary).fixedSize(horizontal: false, vertical: true)
                }
            } else {
                Text("Device unavailable").foregroundColor(.secondary)
                Button("Back") { model.selectedDeviceID = nil }
            }
        }
        .padding(17)
    }

    private func information(_ title: String, _ value: String) -> some View {
        HStack(alignment: .firstTextBaseline) {
            Text(title).foregroundColor(.secondary).frame(width: 77, alignment: .leading)
            Text(value).lineLimit(1).truncationMode(.middle)
                .textSelection(.enabled)
            Spacer(minLength: 0)
        }
    }

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Text("CodasSol").font(.system(size: 16, weight: .semibold))
                Text("MAC").font(.system(size: 9, weight: .bold))
                    .foregroundColor(.secondary)
                Spacer()
                Button { Task { await model.refresh() } } label: {
                    Image(systemName: "arrow.clockwise")
                        .font(.system(size: 12, weight: .medium))
                }.buttonStyle(.borderless).disabled(model.loading)
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 15)
            Divider()
            ScrollView {
                if model.selectedDeviceID != nil { detail } else { listing }
            }.frame(minHeight: 145, maxHeight: 360)
            Divider()
            HStack {
                Text(model.lastUpdated.map { "Synced \($0.formatted(date: .omitted, time: .shortened))" }
                     ?? "Local status only")
                    .font(.system(size: 10)).foregroundColor(.secondary)
                Spacer()
                Button("Quit") { NSApplication.shared.terminate(nil) }
                    .font(.system(size: 11)).buttonStyle(.plain)
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 10)
        }
        .frame(width: 350)
        .background(Color(nsColor: .windowBackgroundColor))
        .onAppear { Task { await model.refresh() } }
    }
}
