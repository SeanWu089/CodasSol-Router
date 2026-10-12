#!/bin/zsh
# Install the literal, case-sensitive terminal command "Codas!".
emulate -L zsh
set -euo pipefail
source_file="${0:A:h}/codas-command.zsh"
target_dir="$HOME/.local/bin"
target="$target_dir/Codas!"
if [[ ! -f "$source_file" ]]; then
  print -u2 -- "Missing Codas! source script"
  exit 66
fi
/bin/mkdir -p "$target_dir"
tmp="$target.tmp.$$"
trap '/bin/rm -f -- "$tmp"' EXIT
/bin/cp "$source_file" "$tmp"
/bin/chmod 755 "$tmp"
/bin/mv -f "$tmp" "$target"
print -- "Installed: $target"
print -- 'Run: Codas!'
