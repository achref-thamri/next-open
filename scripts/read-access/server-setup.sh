#!/usr/bin/env bash
# Server half of read-only access; install.sh runs it over the owner's own SSH key:
#   ssh hetzner 'bash -s -- "<public key>"' < server-setup.sh
# - ~/bin/no-db-read: one SQL query on stdin against Next Open's SQLite file, opened read-only with query_only on, so
#   only statements that return rows run. Prints one JSON object per row.
# - ~/bin/no-logs [30m|2h]: recent logs of the Next Open container.
# - ~/bin/no-read-gate: forced command for the read-only key, which may run those two and nothing else.
# Safe to run again.
set -euo pipefail
public_key=${1:?public key required}
[[ $public_key =~ ^ssh-ed25519\ [A-Za-z0-9+/=]+(\ .*)?$ ]] || { echo "not an ed25519 public key" >&2; exit 64; }

mkdir -p "$HOME/bin"
cat >"$HOME/bin/no-db-read" <<'SCRIPT'
#!/usr/bin/env bash
# Read-only SQL against Next Open's database: one query on stdin, rows out as JSON lines.
set -euo pipefail
cd "$HOME/next-open"
read -r -d '' code <<'JS' || true
const Database = require("better-sqlite3");
const sql = require("node:fs").readFileSync(0, "utf8").trim();
const db = new Database("/data/next-open.db", { readonly: true, fileMustExist: true });
db.pragma("query_only = ON");
const statement = db.prepare(sql);
if (!statement.reader) {
    console.error("only queries that return rows");
    process.exit(64);
}
for (const row of statement.iterate()) console.log(JSON.stringify(row));
JS
exec docker compose exec -T next-open node -e "$code"
SCRIPT
cat >"$HOME/bin/no-logs" <<'SCRIPT'
#!/usr/bin/env bash
# Recent logs of the Next Open container: no-logs [since]; the last hour by default.
set -euo pipefail
since=${1:-1h}
[[ $since =~ ^[0-9]{1,3}[mh]$ ]] || { echo "since must look like 30m or 2h" >&2; exit 64; }
cd "$HOME/next-open"
exec docker compose logs --no-color --since "$since" next-open
SCRIPT
cat >"$HOME/bin/no-read-gate" <<'SCRIPT'
#!/usr/bin/env bash
# Forced command for Next Open's read-only SSH key: whatever the client asks for, only no-db-read and no-logs run.
# The request is split into words, never passed to a shell.
set -euo pipefail
read -r -a words <<<"${SSH_ORIGINAL_COMMAND:-}"
case "${words[0]:-}" in
    no-db-read)
        ((${#words[@]} == 1)) || { echo "no-db-read takes SQL on stdin, no arguments" >&2; exit 64; }
        exec "$HOME/bin/no-db-read"
        ;;
    no-logs)
        ((${#words[@]} <= 2)) || { echo "no-logs [since]" >&2; exit 64; }
        exec "$HOME/bin/no-logs" "${words[@]:1}"
        ;;
    *)
        echo "this key may only run no-db-read or no-logs" >&2
        exit 64
        ;;
esac
SCRIPT
chmod 755 "$HOME/bin/no-db-read" "$HOME/bin/no-logs" "$HOME/bin/no-read-gate"

entry="command=\"$HOME/bin/no-read-gate\",restrict $public_key"
touch "$HOME/.ssh/authorized_keys"
grep -qxF "$entry" "$HOME/.ssh/authorized_keys" || printf '%s\n' "$entry" >>"$HOME/.ssh/authorized_keys"

echo "select count(*) as runs from runs" | "$HOME/bin/no-db-read"
