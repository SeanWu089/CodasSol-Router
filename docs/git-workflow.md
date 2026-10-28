# Git workflow and Worktree responsibilities

Status reviewed on 2026-10-28; verify with `git branch -avv` and `git worktree list` before changing anything.

## Long-lived branches

- **`main`** — public default integration branch, promoted only after regression tests. The October 10 checkpoint integrates macOS Registry v1, the verified Mac routing repairs and CodasSol-mac v0.3.2, plus the earlier Android V0. **The v0.2 Windows distributed/offline acceptance gate is still open.** A Git merge never installs new code on a running machine.
- **`develop`** — up-to-date integrated source branch. The clean, tested Mac v0.3.2 integration is promoted into `develop` before `main`, while dirty Windows installer/health work remains isolated until tested on real hardware.
- **`release/windows-v0.1.0`** — retained historical release branch; old version also retained as tag `v0.1.0`.

## Temporary branches retained deliberately

| Branch | Reason to retain | Worktree |
|---|---|---|
| `feat/mobile-android-v0` | Canonical Desktop project folder has an **uncommitted** `docs/thoughts.md` project-state/roadmap draft. The committed branch tip is already part of `develop`. | `~/Desktop/PROJECTS/CodasSol-Router` |
| `feat/distributed-routing-v0.2` | Has uncommitted Router/backend-health, Windows installer and ngrok experiments; review and test before integration. | `~/.devspace/worktrees/CodasSol-Router-2763118f` |
| `fix/windows-v0.2-unified` | Contains uncommitted documentation and MCP-header forwarding changes. | `~/.devspace/worktrees/CodasSol-Router-2f137a75` |

Avoid new worktrees for every small correction to the same feature. Create a task-specific worktree for independent changes, and remove it after its code is tested, integrated, and clean. Keep a Worktree containing work-in-progress changes until their owner has reviewed them. Never run `git worktree remove --force` or delete branches with uncommitted files.

## Historical features and recovery

Previous Mac `feat/codassol-mac-v0`, `feat/codassol-mac-v0.2` and `feat/codassol-mac-device-panel-v0.3`, plus `feat/device-registry-v1`, were integrated into `develop` before their local branches and six redundant clean Worktrees were removed. Their original commits remain reachable through `develop` and the following tags:

- `codassol-mac-v0.1.0`, `codassol-mac-v0.2.0-rc.1`, `codassol-mac-v0.2.0`, `codassol-mac-v0.2.1`, `codassol-mac-v0.3.0-preview.1`, `codassol-mac-v0.3.1`
- `device-registry-v1.0.0-alpha.1`

To inspect a historical release, use `git show <tag>`; to develop from it, create a **new** feature branch. Do not move existing tags or rewrite the shared commit history.

## Reviewing history without DevSpace snapshot noise

DevSpace manages refs under `refs/devspace/review/*` and `refs/devspace/recovery/*`, which may hold automated review snapshots. They are **not normal feature branches**. Do not delete these refs while DevSpace depends on them.

To see project development history without them:

```sh
git log --graph --oneline --decorate --exclude='refs/devspace/*' --all
```

This checkout already has a `git lg` local alias using `--branches --remotes --tags`, which likewise omits the DevSpace internal review refs. No Git aliases needed to be changed. The alias is local Git configuration, not a tracked repository setting.

## Deployments and user approval

The active macOS Router executes from `~/Library/Application Support/CodasSol/production/current`, which points to an immutable release outside the development checkout. The earlier `~/.local/share/codassol-router` is a backup only. DevSpace uses its installed runtime and the menu app uses `~/Applications/CodasSol-mac.app`. **Updating a Git worktree does not deploy the runtime.** Staging, compiling and testing may proceed normally; deployment requires task authorization for any action that could restart or disconnect Router/DevSpace/MCP. Never publish internal addresses, credentials or device metadata to a public repository.

## Public source synchronization (2026-10-28)

- Feature PRs target `develop`; CI now covers pull requests and pushes to both
  `develop` and `main`, including isolated Python production-helper tests.
- Local unpublished histories can contain private deployment observations.
  Review the full newly reachable history before pushing a branch or tag.
  Where needed, preserve the original branch and dirty worktree locally, then
  export a sanitized source snapshot onto a review branch based on public
  history. Do not push internal review/recovery refs or rewrite shared history.
- `fix/mac-cloudflare-source-sync` carries the public-safe Cloudflare/auth and
  production-helper source. The original private development history is kept
  locally; its different commit IDs are intentional, not missing work.
- Device identities, actual project inventories and fixed private endpoints
  remain in local context. Public examples use neutral paths and hostnames.
- The retained-worktree table above records the October 10 checkpoint, not a
  current inventory; inspect Git and approved local context before cleanup.
- Source synchronization does not close physical acceptance items or reconcile
  production-only routing/SSE/traffic modules. Do that before a runtime release.

## Next safe housekeeping steps

1. Review the three intentionally dirty worktrees individually and commit only finished, tested changes; preserve the project-state draft verbatim.
2. Keep the physically unverified Windows distributed-routing candidate off the release path until legacy Agent recovery and Mac-offline execution are demonstrated.
3. The Mac Router already runs Registry v1, but its un-deployed tri-state Agent-backend status API fix still needs a guarded maintenance window. Windows Registry, peer synchronization and actual execution remain pending.

**Deployment update (2026-10-10):** The Mac Router has now been upgraded to Registry v1 and verified locally, while Windows Router deployment and physical peer synchronization remain pending. The Mac compatibility adjustments (legacy Windows D:/E: handling and peer MCP header forwarding) have been preserved in source through `fix/device-routing-v0.2`. Merging that source does **not** redeploy the live Router; its tri-state Agent backend reporting update still needs guarded deployment. See [Mac Registry cutover notes](deployments/2026-10-10-mac-device-registry-v1.md) before replacing the live runtime again.
