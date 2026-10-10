# Git workflow and Worktree responsibilities

Status reviewed on 2026-10-10; verify with `git branch -avv` and `git worktree list` before changing anything.

## Long-lived branches

- **`main`** — manually promoted stable code. It is not the deployed runtime; `origin/main` is currently behind local `main`. No automatic pushes or releases.
- **`develop`** — integrated development code. On 2026-10-10, it includes the committed distributed Router v0.2, Windows startup repair, Device Registry v1, Android V0 and CodasSol-mac v0.3.1 histories, with Node and macOS regression suites passing. This is a source integration checkpoint, **not** proof that Registry v1 is running on physical devices.
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

The active macOS Router executes from `~/.local/share/codassol-router`; DevSpace uses its installed runtime and the menu app uses `~/Applications/CodasSol-mac.app`. **Updating a Git worktree does not deploy the runtime.** Staging, compiling and testing may proceed normally; warn and obtain approval before any action that could restart or disconnect Router/DevSpace/MCP. Never publish internal addresses, credentials or device metadata to a public repository.

## Next safe housekeeping steps

1. Review the three intentionally dirty worktrees individually and commit only finished, tested changes; preserve the project-state draft verbatim.
2. Merge validated follow-ups into `develop`, verify Mac/Windows/Router compatibility, and only then consider a stable `main` promotion.
3. Deploy actual Registry v1 to the Mac/Windows only in an explicitly approved interruption window; physical-device testing remains outstanding.

**Deployment update (2026-10-10):** The Mac Router has now been upgraded to Registry v1 and verified locally, while Windows Router deployment and physical peer synchronization remain pending. The deployed Mac binary includes two existing compatibility adjustments not yet present in `develop`. See [Mac Registry cutover notes](deployments/2026-10-10-mac-device-registry-v1.md) before replacing the live runtime again.
