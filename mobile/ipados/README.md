# CodasSol iPad Controller · 0.1.0 development

**Route the Project, Not Devices.**

原生 SwiftUI iPad 控制端。此 iPad 显示在设备列表顶部，可单独配对多台 Router；前台约每 10 秒刷新状态，分别呈现在线、离线与当前无法验证。

## 构建与安装

首选 [不安装本地 Xcode 的云端构建](NO-XCODE-GUIDE.md)：将 `feat/ipados-cloud-build` 推送至你自己的 `SeanWu089/CodasSol-Router` 仓库，GitHub Actions 自动编译未签名 IPA，然后在 Mac/Windows 使用 Sideloadly 完成签名安装。

如本地已有 Xcode，可打开 `CodasSolController.xcodeproj`，选择自己的 Apple Team 与 iPad 运行；或执行 `bash BUILD-IPA.command` 生成未签名 IPA。最低系统版本为 iPadOS 17。

**源码和未签名 IPA 均不能直接点击安装。** 构建、签名、真机连接是不同的验证步骤。

## Router 侧接口

在独立 worktree 或测试副本中安装，只改该副本的 `src/server.js` 并新增 `src/controller-api.js`：

```bash
cd mobile/ipados
npm test
bash scripts/install-router-addon.sh /absolute/path/to/CodasSol-Router
```

安装器严格匹配 v0.2 的入口结构，校验语法并运行测试；失败时恢复原文件。它不会修改配对密钥。成功后，在实际 Router 进程的启动配置中设置以下变量，再重启该进程：

```bash
CODASSOL_CONTROLLER_PORT=17677
CODASSOL_CONTROLLER_HOST=127.0.0.1
```

上述地址只允许本机访问。供同一可信局域网内的 iPad 连接时，将 HOST 设为该电脑的局域网地址，并允许对应的局域网防火墙访问。由 launchd 或其他服务管理器启动的进程，需要在其启动配置中设置变量；终端单独 export 不会改变已有服务。避免在相同端口启动第二个 Router。

从目标 Router 项目根目录获取配对密钥：

```bash
npm run router:pairing-token --silent
```

在 iPad 的 Router 管理页面添加名称、地址和该密钥，例如 `http://192.168.1.10:17677`，并明确启用“允许局域网 HTTP”。Debug 和 Release 使用相同的地址校验；公网地址必须为 HTTPS。跨网使用应配置可信 VPN/HTTPS，不直接将 17676/17677 映射到公网。

## 范围

- 专用端口仅提供配对和只读设备查询，不提供 MCP 执行入口。
- iPad 长期凭据保存在 Keychain；Router 仅保存凭据哈希，设备快照不包含文件路径和凭据。
- Router 不可达时，历史设备记录显示为“当前无法验证”。在线状态与执行后端可达状态分别展示。
- Mac 离线后仍可查询已独立运行、已安装接口且网络可达的 Windows Router。
- 尚未实现跨节点设备重命名同步、远程 Shell、iPad DevSpace 执行、自动公网穿透和后台常驻服务。

## 验证

```bash
node --test test/*.test.js mobile/ipados/tests/*.test.mjs  # 从仓库根目录
```

macOS runner 还会运行 30 个地址校验用例与完整 Xcode Release 构建。请以该提交对应的 Actions 结果为准；Linux 环境中的 Node 测试不能证明 iPad 原生程序已经编译或真机连接成功。

蓝色应用图标与 Mac 菜单栏黑白图标分别维护。
