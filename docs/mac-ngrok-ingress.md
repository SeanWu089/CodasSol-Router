# Mac ingress: three independent services

The public MCP endpoint must always reach **CodasSol Router**, not DevSpace.
For this installation the fixed sequence is:

`ChatGPT → fixed HTTPS ngrok domain → Router localhost:17676 → DevSpace localhost:7676`.

## Who starts what

- `com.codassol.devspace.mac` is owned by the existing CodasSol Mac
  status-bar application's LaunchAgent. Leave it running independently.
- `com.codassol.router` is owned by the existing Router LaunchAgent.
- `com.codassol.ngrok.ingress` is a new, separate ngrok LaunchAgent
  (RunAtLoad + KeepAlive), forwarding the fixed public domain exclusively
  to **localhost:17676**. The domain is explicit in its plist rather
  than rediscovered from DevSpace on every restart.

The Mac must be awake and connected for its ingress to work. A separate
v0.3 dynamic-ingress feature may later allow another machine to take
over; this LaunchAgent does not claim to implement failover.

## Check and stage

```zsh
zsh scripts/mac/manage-ngrok-ingress.sh status
zsh scripts/mac/manage-ngrok-ingress.sh --stage
```

The stage command validates Router `/_codassol/health` and
`backendReachable` before copying scripts to
`~/.local/share/codassol-router/bin` and writing a protected
`~/Library/LaunchAgents/com.codassol.ngrok.ingress.plist`. It does not
start or kill any production process. It reads the fixed URL from an
existing *single* ngrok Agent tunnel or `CODASSOL_PUBLIC_URL`.

## One-time safe migration

```zsh
zsh scripts/mac/manage-ngrok-ingress.sh --migrate
```

The detached migration checks that the old ngrok process (port 4040)
belongs to the exact fixed domain and points only to 7676. It terminates
that **one verified PID**, then starts the dedicated LaunchAgent.
It requires the new tunnel to appear in ngrok's local management API
on port 17676, checks real public Router health, and expects an
unauthenticated MCP POST to return HTTP **401**. An independent rollback
guard restores the **original** 7676 tunnel if new ingress verification
fails. Check `~/.codassol/ngrok-ingress-migration-*.log` for evidence.

While migration runs, existing MCP sessions may disconnect briefly and
reconnect. No DevSpace or Router restart is needed. A 401 without valid
authorization is **expected**, not a failed health check.

## Day-to-day

Use `zsh ~/.local/share/codassol-router/bin/manage-ngrok-ingress.sh status`.
The legacy `start-devspace-ngrok`/ `start-ngrok-devspace` aliases
are compatibility wrappers around **managed ngrok**; they no longer
start/kill DevSpace or choose port 7676.

Do not manually run `ngrok http 7676` for CodasSol. If the domain still
serves DevSpace directly or any service state is ambiguous, inspect
process ownership before restarting or changing launchd services.
