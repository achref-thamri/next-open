#!/usr/bin/env bash
# Deploys a tar of the repo read from stdin, then waits for the container to report healthy.
#
# Installed on the server as ~/bin/deploy and bound to the CI deploy key in ~/.ssh/authorized_keys:
#   command="/home/bot/bin/deploy",restrict ssh-ed25519 AAAA... github-actions-deploy
# so that key can run nothing else. After changing this file, copy it to the server again by hand.
set -euo pipefail

APP_DIR="$HOME/trading-bot"
SERVICE=trading-bot

# A restart cancels a running job and the scheduler never replays it, so stay clear of the open and the
# post-close jobs on weekdays (New York time).
now=$(TZ=America/New_York date +%H%M)
weekday=$(TZ=America/New_York date +%u)
if ((weekday <= 5)) && { ((10#$now >= 915 && 10#$now < 945)) || ((10#$now >= 1615 && 10#$now < 1745)); }; then
    echo "refusing to deploy at $now New York time: a trading job may be running; retry later" >&2
    exit 75
fi

exec 9>"$HOME/.deploy.lock"
flock -n 9 || { echo "another deploy is running" >&2; exit 75; }

# Unpack aside first, so empty or partial input never touches the running checkout.
incoming=$(mktemp -d)
trap 'rm -rf "$incoming"' EXIT
tar -xf - -C "$incoming"
[[ -f $incoming/docker-compose.yml && -f $incoming/package.json ]] || { echo "input is not the repo" >&2; exit 65; }
cp -a "$incoming/." "$APP_DIR/"

cd "$APP_DIR"
docker compose up -d --build --remove-orphans

container=$(docker compose ps -q "$SERVICE")
for _ in $(seq 1 36); do
    status=$(docker inspect --format '{{.State.Health.Status}}' "$container")
    if [[ $status == healthy ]]; then
        echo "deployed: $SERVICE is healthy"
        exit 0
    fi
    sleep 5
done
echo "$SERVICE did not become healthy within 3 minutes (last status: $status)" >&2
docker compose logs --tail=50 "$SERVICE" >&2
exit 1
