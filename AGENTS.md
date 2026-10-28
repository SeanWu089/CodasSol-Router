# CodasSol-Router development rules

- Read `docs/findings.md`, `docs/thoughts.md`, `docs/todos.md`,
  `docs/git-workflow.md`, and `SECURITY.md` before substantial work.
- Keep the owner's authoritative development checkout and isolated review
  worktrees distinct. Preserve dirty worktrees and existing local instructions.
- Integrate reviewed work into `develop`; promote to `main` after regression
  checks. Never force-push shared history or move an existing release tag.
- Before publishing, inspect newly reachable commits as well as the current
  diff. Keep real device identities, fixed private ingress addresses, local
  project inventories, credentials, and runtime state out of the public repo.
  Use neutral examples and private environment configuration instead.
- Production is independent of the development checkout and any cloud-synced
  Desktop. The supported macOS runtime uses an immutable release under
  `~/Library/Application Support/CodasSol/production`, with an atomic `current`
  symlink and separate `bin` launchers. The legacy runtime is backup only.
- A Git update does not deploy services. Deploy only when the task authorizes
  it, after review, an isolated dry run, and a rollback plan. Do not promote this
  source over a newer runtime until production-only modules are reconciled.
- Verify the physical hostname and OS before device-specific actions. If more
  than one device fits, resolve the intended device; never infer execution
  readiness from heartbeat or a green UI indicator alone.
- Preserve per-device configuration, enrollment IDs, local canonical paths,
  and existing credentials. Read those details from approved local context;
  do not add a real machine inventory to these public instructions.
- Keep accepted transport constraints and existing service health intact.
  The current ingress supports Cloudflare Tunnel with authenticated outbound
  SSE; do not silently substitute a different network architecture.
- Update the three canonical project-memory files at meaningful checkpoints.
  Preserve unconfirmed ideas separately from accepted work. Keep automated
  checks separate from user acceptance; mark a user test passed only after
  explicit user confirmation, retaining failed and pending test IDs.
- Run relevant tests and review the final diff before committing. Source
  validation does not establish reboot, sleep/wake, or physical Windows
  acceptance, which remain separate gates.
