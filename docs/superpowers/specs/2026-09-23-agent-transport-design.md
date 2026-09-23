# CodasSol Agent Transport Design

## Goal

Connect remote computers to CodasSol Router without exposing their DevSpace
ports to the Internet. A remote Agent always initiates outbound traffic to the
Router and talks to DevSpace only through loopback on its own machine.

## Trust boundaries

There are three independent credentials:

1. ChatGPT / MCP authentication belongs to the public Router-facing endpoint.
2. Router-to-Agent authentication uses a per-device Agent token.
3. Agent-to-DevSpace authentication uses that machine's local DevSpace OAuth.

DevSpace owner tokens, access tokens and refresh tokens never leave the device
that owns them.

## Enrollment

The Router keeps private deployment state under `~/.codassol/`. On first
initialization it generates a high-entropy pairing token.

An Agent presents that pairing token once to enroll. The Router then issues a
separate random Agent token for that device and stores only its hash. The Agent
stores its token locally in a mode-600 private config file.

The pairing token is not stored by the Agent and is not used for normal
operation.

## Outbound transport

V1 uses authenticated HTTPS/HTTP long polling rather than WebSockets. This
keeps the implementation dependency-free and works through ordinary reverse
proxies and tunnels.

The Agent:

1. sends heartbeats;
2. long-polls for one pending job;
3. executes the job against local DevSpace;
4. posts the response to the Router.

The protocol is transport-oriented and does not grant arbitrary Router shell
access to the Agent process itself. Jobs carry HTTP requests intended for the
local DevSpace endpoint.

## Local DevSpace OAuth

The Agent is a local OAuth client of DevSpace:

1. discover the DevSpace protected resource from loopback;
2. dynamically register a public OAuth client;
3. use PKCE authorization;
4. approve the local authorization request using the owner token from
   `~/.devspace/auth.json`;
5. keep refresh/access tokens only in Agent private state;
6. refresh automatically and re-authorize only when necessary.

No authentication bypass is introduced.

## Routing

The existing Device Registry and workspace binding remain authoritative.
`open_workspace` selects one device. Once a backend returns a workspace ID,
the Router binds that ID to the selected device. Every later tool call carrying
that workspace ID is sent only to that device.

## Development deployment

During development the Router may run on the Mac while the existing public
DevSpace endpoint continues to point directly at port 7676.

For same-LAN testing, the Router can additionally listen on the Mac LAN
interface. This does not expose Windows DevSpace; only the authenticated Agent
control endpoints become reachable.

The final architecture can move the Router to an always-on independent host
without changing the Agent protocol.

