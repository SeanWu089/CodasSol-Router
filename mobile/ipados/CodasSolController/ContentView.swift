import SwiftUI

private func statusColor(_ status: DevicePresence) -> Color {
    switch status {
    case .online: return .green
    case .offline: return .gray
    case .unverified: return .orange
    }
}

private func iconFor(_ platform: String) -> String {
    switch platform.lowercased() {
    case "darwin", "macos": return "laptopcomputer"
    case "win32", "windows": return "desktopcomputer"
    case "ipados", "ios": return "ipad"
    default: return "server.rack"
    }
}

struct ContentView: View {
    @EnvironmentObject private var hub: ControllerHub
    @Environment(\.scenePhase) private var scenePhase
    @State private var selectedDevice: String? = "self"
    @State private var showingRouters = false

    var body: some View {
        NavigationSplitView {
            List(selection: $selectedDevice) {
                Section("此设备") {
                    HStack(spacing: 12) {
                        Image(systemName: "ipad")
                            .font(.title3)
                            .frame(width: 32)
                        VStack(alignment: .leading, spacing: 3) {
                            Text(hub.localName).font(.headline)
                            Text("本地控制端 · 已启动")
                                .font(.caption).foregroundStyle(.secondary)
                        }
                        Spacer()
                        Circle().fill(.green).frame(width: 8, height: 8)
                    }
                    .padding(.vertical, 5)
                    .tag("self")
                }
                Section("其他已登记设备") {
                    ForEach(hub.nodes) { node in
                        HStack(spacing: 12) {
                            Image(systemName: iconFor(node.platform))
                                .font(.title3).frame(width: 32)
                            VStack(alignment: .leading, spacing: 3) {
                                Text(node.label).font(.headline).lineLimit(1)
                                Text(node.presence.text)
                                    .font(.caption).foregroundStyle(.secondary)
                            }
                            Spacer()
                            Circle()
                                .fill(statusColor(node.presence))
                                .frame(width: 8, height: 8)
                        }
                        .padding(.vertical, 5)
                        .tag(node.id)
                    }
                    if hub.nodes.isEmpty {
                        ContentUnavailableView("尚无设备", systemImage: "network",
                            description: Text("先添加一台可达的 CodasSol Router。"))
                    }
                }
                Section {
                    if hub.routers.isEmpty {
                        Label("尚未配对 Router", systemImage: "exclamationmark.circle")
                            .foregroundStyle(.secondary)
                    } else {
                        ForEach(hub.routers) { profile in
                            HStack {
                                Circle()
                                    .fill(hub.routerReachable[profile.id] == true ? .green : .orange)
                                    .frame(width: 7, height: 7)
                                Text(profile.name)
                                Spacer()
                                Text(hub.routerReachable[profile.id] == true ? "可达" : "待验证")
                                    .foregroundStyle(.secondary)
                            }
                            .font(.caption)
                        }
                    }
                } header: { Text("接入的路由节点") }
            }
            .navigationTitle("CodasSol")
            .toolbar {
                ToolbarItemGroup(placement: .topBarTrailing) {
                    Button {
                        Task { await hub.refresh() }
                    } label: {
                        if hub.refreshing { ProgressView() }
                        else { Image(systemName: "arrow.clockwise") }
                    }
                    .disabled(hub.refreshing)
                    .accessibilityLabel("刷新设备状态")
                    Button { showingRouters = true } label: {
                        Image(systemName: "gearshape")
                    }
                    .accessibilityLabel("管理 Router")
                }
            }
            .refreshable { await hub.refresh() }
        } detail: {
            if selectedDevice == "self" {
                LocalDeviceDetail(name: hub.localName, id: hub.localID,
                                  routerCount: hub.routers.count)
            } else if let selected = hub.nodes.first(where: { $0.id == selectedDevice }) {
                RemoteDeviceDetail(node: selected)
            } else {
                ContentUnavailableView("选择设备", systemImage: "network",
                    description: Text("查看连接状态和设备身份。"))
            }
        }
        .sheet(isPresented: $showingRouters) {
            RouterSettingsView()
                .environmentObject(hub)
        }
        .task(id: scenePhase) {
            guard scenePhase == .active else { return }
            await hub.refresh()
            while !Task.isCancelled {
                do { try await Task.sleep(for: .seconds(10)) }
                catch { break }
                if !Task.isCancelled { await hub.refresh() }
            }
        }
    }
}

private struct InfoLine: View {
    let title: String
    let detail: String
    var body: some View {
        HStack(alignment: .firstTextBaseline) {
            Text(title).foregroundStyle(.secondary)
            Spacer(minLength: 16)
            Text(detail).multilineTextAlignment(.trailing).textSelection(.enabled)
        }
        .padding(.vertical, 5)
    }
}

struct LocalDeviceDetail: View {
    let name: String
    let id: String
    let routerCount: Int

    var body: some View {
        Form {
            Section {
                Label("本地控制端已启动", systemImage: "checkmark.circle.fill")
                    .foregroundStyle(.green)
                    .font(.headline)
                InfoLine(title: "设备名称", detail: name)
                InfoLine(title: "平台", detail: "iPadOS")
                InfoLine(title: "角色", detail: "Control Only")
                InfoLine(title: "配对路由节点", detail: "\(routerCount)")
            } header: { Text("此 iPad") }
            Section("设备身份") {
                Text(id).font(.footnote.monospaced()).textSelection(.enabled)
            }
            Section("工作方式") {
                Text("iPad 直接访问已配对且可达的 Router。连接不依赖某一台固定 Mac，但需要目标节点自身在线并且网络可达。")
                Text("此版本仅提供查询与连接诊断，不在 iPad 上执行 DevSpace，也不会在后台维持常驻服务。")
                    .foregroundStyle(.secondary)
            }
        }
        .navigationTitle(name)
    }
}

struct RemoteDeviceDetail: View {
    let node: VisibleNode

    var body: some View {
        Form {
            Section {
                HStack {
                    Label(node.presence.text, systemImage: "circle.fill")
                        .foregroundStyle(statusColor(node.presence))
                    Spacer()
                    Text(node.platform).foregroundStyle(.secondary)
                }
                InfoLine(title: "名称", detail: node.label)
                InfoLine(title: "设备 ID", detail: node.deviceID)
                InfoLine(title: "类型", detail: node.kind)
                InfoLine(title: "连接入口", detail: node.observedVia.joined(separator: "、"))
            } header: { Text("连接状态") }
            Section("执行后端") {
                if let reachable = node.backendReachable {
                    Label(reachable ? "DevSpace 可达" : "DevSpace 不可达",
                          systemImage: reachable ? "checkmark.circle" : "exclamationmark.triangle")
                } else {
                    Label("尚未独立验证 DevSpace", systemImage: "questionmark.circle")
                        .foregroundStyle(.secondary)
                }
            }
            if !node.notes.isEmpty {
                Section("验证提醒") {
                    ForEach(node.notes, id: \.self) { note in Text(note) }
                }
            }
            Section {
                Text("绿色仅代表此设备在当前查询的 Router 视角下在线；不能据此断言所有 MCP 操作都能执行。")
                    .foregroundStyle(.secondary)
            }
        }
        .navigationTitle(node.label)
    }
}

struct RouterSettingsView: View {
    @EnvironmentObject private var hub: ControllerHub
    @Environment(\.dismiss) private var dismiss
    @State private var showingAdd = false

    var body: some View {
        NavigationStack {
            List {
                ForEach(hub.routers) { router in
                    VStack(alignment: .leading, spacing: 6) {
                        HStack {
                            Text(router.name).font(.headline)
                            Spacer()
                            Text(hub.routerReachable[router.id] == true ? "已连接" : "无法验证")
                                .foregroundStyle(hub.routerReachable[router.id] == true ? Color.green : Color.orange)
                                .font(.caption)
                        }
                        Text(router.address).font(.footnote).foregroundStyle(.secondary)
                            .textSelection(.enabled)
                        if let error = hub.routerErrors[router.id] {
                            Text(error).font(.caption).foregroundStyle(.red)
                        }
                        if router.allowInsecureHTTP {
                            Label("已允许非加密 HTTP（仅限可信测试网络）",
                                  systemImage: "exclamationmark.triangle")
                                .font(.caption).foregroundStyle(.orange)
                        }
                    }
                    .padding(.vertical, 5)
                }
                .onDelete { offsets in
                    let ids = offsets.map { hub.routers[$0].id }
                    for id in ids { hub.removeRouter(id) }
                }
                Section {
                    Text("每台 Router 单独配对。Mac 离线时，若 Windows Router 可达，iPad 仍可从 Windows 获取状态。")
                        .font(.footnote).foregroundStyle(.secondary)
                }
            }
            .navigationTitle("Router 管理")
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("完成") { dismiss() }
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button { showingAdd = true } label: { Image(systemName: "plus") }
                }
            }
            .sheet(isPresented: $showingAdd) {
                AddRouterView().environmentObject(hub)
            }
        }
    }
}

struct AddRouterView: View {
    @EnvironmentObject private var hub: ControllerHub
    @Environment(\.dismiss) private var dismiss
    @State private var name = ""
    @State private var address = ""
    @State private var pairingToken = ""
    @State private var allowHTTP = false
    @State private var busy = false
    @State private var errorMessage: String?

    var body: some View {
        NavigationStack {
            Form {
                Section("Router") {
                    TextField("名称，例如 Windows PC", text: $name)
                    TextField("https://router.example.com", text: $address)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .keyboardType(.URL)
                    SecureField("一次性配对密钥", text: $pairingToken)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                }
                Section {
                    Toggle("允许局域网 HTTP（仅测试）", isOn: $allowHTTP)
                    Text("HTTP 会在局域网中明文传输配对密钥。正式使用请改用 HTTPS 或可靠的加密隧道。")
                        .font(.footnote).foregroundStyle(.secondary)
                }
                if let errorMessage {
                    Section("连接失败") { Text(errorMessage).foregroundStyle(.red) }
                }
            }
            .navigationTitle("添加 Router")
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("取消") { dismiss() }
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button("配对") {
                        busy = true
                        errorMessage = nil
                        Task {
                            do {
                                try await hub.addRouter(
                                    name: name, address: address,
                                    pairingToken: pairingToken, allowHTTP: allowHTTP
                                )
                                pairingToken = ""
                                dismiss()
                            } catch { errorMessage = error.localizedDescription }
                            busy = false
                        }
                    }
                    .disabled(busy || address.isEmpty || pairingToken.isEmpty)
                }
            }
        }
    }
}
