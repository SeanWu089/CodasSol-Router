# iPad 云端构建与安装（本地不用安装 Xcode）

本工程属于 `SeanWu089/CodasSol-Router`，iPad 开发分支为 `feat/ipados-cloud-build`，基于 `fix/windows-v0.2-unified`。不需要另建仓库。

## 云端构建

将分支推送到你自己的仓库：

```bash
git push -u origin feat/ipados-cloud-build
```

该分支首次推送就会自动触发 `.github/workflows/build-ipad.yml`，无需先把工作流合并到 `main`。首次构建使用 push 触发即可。

在仓库的 **Actions → Build CodasSol iPad IPA (no local Xcode)** 查看运行结果。流程先运行 Router/API 测试，再用 GitHub macOS runner 验证地址策略、调用 Xcode 编译 iPad 实机程序。成功后下载 **Artifacts → CodasSol-iPad-unsigned-IPA**，解压得到 `CodasSol-iPad-Controller-unsigned.ipa`。

只有 Actions 的编译步骤成功，才表示 IPA 已生成。源码 ZIP、补丁和本地 Git 提交均不是安装包。本工作流不需要 Apple ID、签名证书或个人令牌。

## 安装到 iPad

1. 在 Mac 或 Windows 安装官方 [Sideloadly](https://sideloadly.io/)，不需要本地 Xcode。
2. USB 连接并解锁 iPad，按提示信任电脑。
3. 将构建生成的 IPA 拖入 Sideloadly，在该程序中自行完成 Apple ID 签名与安装。
4. 按 iPad 系统提示完成开发者信任或 Developer Mode 设置。

签名账号和凭据由你在自己的设备上处理，不放入项目或聊天。免费账号的续签与安装限制以 Apple 和侧载工具的当前规则为准。

## 连接电脑

按 [README.md](README.md) 在目标 Router 安装独立控制接口。iPad 默认使用 HTTPS；可信局域网 HTTP 必须手动启用，并且地址需通过本地地址校验。Mac 和 Windows 各自配对；任意节点离线不影响其他可达节点的查询。

当前版本是设备状态控制端，还不在 iPad 上执行 Shell/DevSpace，也未提供全设备重命名同步。
