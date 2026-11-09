#!/usr/bin/env bash
# Read-only access to Next Open on the server, for checks without the owner's own key; run once on the Mac:
#   bash scripts/read-access/install.sh
# - A separate key, ~/.ssh/next_open_read, which the server only lets run no-db-read (one read-only SQL query) and
#   no-logs (container logs). It has no passphrase because it can do nothing else.
# - An SSH alias `next-open-read` for that key, added to ~/.ssh/config if missing.
# - The server half (server-setup.sh), sent over the owner's own `hetzner` alias.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
key="$HOME/.ssh/next_open_read"
# The server address comes from the owner's `hetzner` alias, so it isn't written in the repo.
host=$(ssh -G hetzner | awk '$1 == "hostname" { print $2 }')

[[ -f $key ]] || ssh-keygen -q -t ed25519 -N "" -C "next-open read-only" -f "$key"

if ! grep -q "^Host next-open-read$" "$HOME/.ssh/config" 2>/dev/null; then
    cat >>"$HOME/.ssh/config" <<CONFIG

# Read-only checks on Next Open: the server only lets this key run no-db-read and no-logs.
Host next-open-read
  HostName $host
  User bot
  IdentityFile $key
  IdentitiesOnly yes
CONFIG
fi

ssh hetzner "bash -s -- '$(cat "$key.pub")'" <"$here/server-setup.sh"
echo
echo "Done. Test: echo 'select type, status, started_at from runs order by started_at desc limit 5' | ssh next-open-read no-db-read"
