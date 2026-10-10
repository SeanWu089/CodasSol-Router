#!/bin/zsh
# Stable launchd entrypoint: never rely on a global npm shim or shell PATH.
emulate -L zsh
set -euo pipefail
setopt NULL_GLOB

mode="${1:---diagnose}"
if [[ "$mode" != "--diagnose" && "$mode" != "--serve" ]]; then
  print -u2 -- 'Usage: devspace-runner.zsh --diagnose|--serve'
  exit 2
fi

typeset -a packages nodes

# A manually configured package path is authoritative (and testable).
if [[ -n "${CODASSOL_DEVSPACE_PACKAGE:-}" ]]; then
  packages+=("$CODASSOL_DEVSPACE_PACKAGE")
else
  packages+=(
    "$HOME/.local/npm-global/lib/node_modules/@waishnav/devspace"
    "$HOME/.npm-global/lib/node_modules/@waishnav/devspace"
    "$HOME/.local/share/fnm/node-versions/"*/installation/lib/node_modules/@waishnav/devspace(N)
    "$HOME/.nvm/versions/node/"*/lib/node_modules/@waishnav/devspace(N)
    "$HOME/.volta/tools/image/node/"*/lib/node_modules/@waishnav/devspace(N)
    /opt/homebrew/lib/node_modules/@waishnav/devspace
    /usr/local/lib/node_modules/@waishnav/devspace
  )
fi

cli=''
for package in "${packages[@]}"; do
  [[ -f "$package/package.json" ]] || continue
  /usr/bin/grep -Eq '"name"[[:space:]]*:[[:space:]]*"@waishnav/devspace"' "$package/package.json" || continue
  # dist/cli.js is the documented npm start entry and survived the Windows shim bug.
  if [[ -f "$package/dist/cli.js" ]]; then
    cli="$package/dist/cli.js"
    break
  fi
  # No fallback to bin/devspace.js: Windows proved that shim targets can vanish.
done

if [[ -z "$cli" ]]; then
  print -u2 -- 'DevSpace package missing or invalid: expected @waishnav/devspace/dist/cli.js. Reinstall DevSpace or configure CODASSOL_DEVSPACE_PACKAGE.'
  exit 20
fi

if [[ -n "${CODASSOL_NODE_BIN:-}" ]]; then
  nodes+=("$CODASSOL_NODE_BIN")
else
  nodes+=(
    "$HOME/.local/share/fnm/aliases/default/bin/node"
    "$HOME/.local/share/fnm/node-versions/"*/installation/bin/node(N)
    "$HOME/.nvm/versions/node/"*/bin/node(N)
    "$HOME/.volta/bin/node"
    /opt/homebrew/bin/node
    /usr/local/bin/node
    /usr/bin/node
  )
fi

node=''
for candidate in "${nodes[@]}"; do
  [[ -x "$candidate" && -f "$candidate" ]] || continue
  version="$("$candidate" -p 'process.versions.node' 2>/dev/null)" || continue
  major="${version%%.*}"
  if [[ "$major" == <-> ]] && (( major >= 22 )); then
    node="$candidate"
    break
  fi
done

if [[ -z "$node" ]]; then
  print -u2 -- 'Compatible Node.js >=22 not found. Install Node 22+ or configure CODASSOL_NODE_BIN.'
  exit 21
fi

# Catch broken npm installs that still contain the entrypoint but are missing
# runtime imports (similar to the Windows MODULE_NOT_FOUND failure).
if ! version_output="$("$node" "$cli" --version 2>&1)"; then
  print -u2 -- "DevSpace runtime validation failed at $cli: $version_output"
  exit 22
fi

if [[ "$mode" == '--diagnose' ]]; then
  print -r -- "READY: Node $node; DevSpace $cli ($version_output)"
  exit 0
fi

# launchd has a very small default PATH. Preserve common tool locations for
# DevSpace subprocesses and place the resolved Node installation first.
export PATH="${node:h}:$HOME/.local/npm-global/bin:$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
exec "$node" "$cli" serve
