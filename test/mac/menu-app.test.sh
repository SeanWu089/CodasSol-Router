#!/bin/zsh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
RUNNER="$SCRIPT_DIR/../../scripts/mac/menu-app/devspace-runner.zsh"
TEMP="$(mktemp -d)"
trap 'rm -rf "$TEMP"' EXIT

mkdir -p "$TEMP/home/.local/npm-global/lib/node_modules/@waishnav/devspace/dist"
PACKAGE="$TEMP/home/.local/npm-global/lib/node_modules/@waishnav/devspace"
print -r -- '{"name":"@waishnav/devspace","version":"1.1.0-test"}' > "$PACKAGE/package.json"
print -r -- 'console.log("MOCK_DEVSPACE", process.argv.slice(2).join(" "));' > "$PACKAGE/dist/cli.js"
NODE="$(command -v node)"

output="$(HOME="$TEMP/home" CODASSOL_NODE_BIN="$NODE" zsh "$RUNNER" --diagnose)"
[[ "$output" == *'READY:'* && "$output" == *'/dist/cli.js'* ]] || { print -u2 -- "FAIL: expected direct CLI path: $output"; exit 1; }
print -- 'PASS: valid package located without npm bin shim'

output="$(HOME="$TEMP/home" CODASSOL_NODE_BIN="$NODE" zsh "$RUNNER" --serve)"
[[ "$output" == 'MOCK_DEVSPACE serve' ]] || { print -u2 -- "FAIL: direct CLI invocation: $output"; exit 1; }
print -- 'PASS: launches dist CLI using resolved Node'

# Move the package and make the npm binary shim nonexistent. The resolver must
# find the nvm installation and the fnm Node binary without relying on PATH.
FALLBACK="$TEMP/home/.nvm/versions/node/v22.1.0/lib/node_modules/@waishnav/devspace"
mkdir -p "${FALLBACK:h}"
mv "$PACKAGE" "$FALLBACK"
mkdir -p "$TEMP/home/.local/share/fnm/aliases/default/bin"
ln -s "$NODE" "$TEMP/home/.local/share/fnm/aliases/default/bin/node"
output="$(HOME="$TEMP/home" zsh "$RUNNER" --diagnose)"
[[ "$output" == *"$FALLBACK/dist/cli.js"* ]] || { print -u2 -- "FAIL: moved npm package not rediscovered: $output"; exit 1; }
print -- 'PASS: moved package and Node found through alternative installation roots'
mv "$FALLBACK" "$PACKAGE"

mv "$PACKAGE/dist/cli.js" "$PACKAGE/dist/cli.js.missing"
if HOME="$TEMP/home" CODASSOL_NODE_BIN="$NODE" zsh "$RUNNER" --diagnose >"$TEMP/stdout" 2>"$TEMP/stderr"; then
  print -u2 -- 'FAIL: accepted missing dist/cli.js'
  exit 1
fi
/usr/bin/grep -q 'DevSpace package missing' "$TEMP/stderr" || exit 1
print -- 'PASS: missing CLI fails closed, not via stale npm shim'
mv "$PACKAGE/dist/cli.js.missing" "$PACKAGE/dist/cli.js"

print -r -- "require('./does-not-exist.js')" > "$PACKAGE/dist/cli.js"
if HOME="$TEMP/home" CODASSOL_NODE_BIN="$NODE" zsh "$RUNNER" --diagnose >"$TEMP/stdout" 2>"$TEMP/stderr"; then
  print -u2 -- 'FAIL: accepted a DevSpace entrypoint with broken dependencies'
  exit 1
fi
/usr/bin/grep -q 'runtime validation failed' "$TEMP/stderr" || exit 1
print -- 'PASS: missing runtime dependency fails before service startup'
print -r -- 'console.log("MOCK_DEVSPACE", process.argv.slice(2).join(" "));' > "$PACKAGE/dist/cli.js"

if HOME="$TEMP/home" CODASSOL_NODE_BIN="$TEMP/does-not-exist" zsh "$RUNNER" --diagnose >"$TEMP/stdout" 2>"$TEMP/stderr"; then
  print -u2 -- 'FAIL: accepted missing Node'
  exit 1
fi
/usr/bin/grep -q 'Compatible Node.js' "$TEMP/stderr" || exit 1
print -- 'PASS: missing Node fails closed'

cat > "$TEMP/too-old-node" <<'EOF'
#!/bin/sh
echo 20.0.0
EOF
chmod +x "$TEMP/too-old-node"
if HOME="$TEMP/home" CODASSOL_NODE_BIN="$TEMP/too-old-node" zsh "$RUNNER" --diagnose >"$TEMP/stdout" 2>"$TEMP/stderr"; then
  print -u2 -- 'FAIL: accepted Node <22'
  exit 1
fi
print -- 'PASS: incompatible Node fails closed'

mkdir -p "$TEMP/override/dist"
print -r -- '{"name":"unrelated-package"}' > "$TEMP/override/package.json"
print -r -- 'console.log("bad")' > "$TEMP/override/dist/cli.js"
if HOME="$TEMP/home" CODASSOL_DEVSPACE_PACKAGE="$TEMP/override" CODASSOL_NODE_BIN="$NODE" zsh "$RUNNER" --diagnose >"$TEMP/stdout" 2>"$TEMP/stderr"; then
  print -u2 -- 'FAIL: accepted a package with the wrong identity'
  exit 1
fi
print -- 'PASS: wrong package identity fails closed'

print -- 'All macOS launcher path tests passed.'
