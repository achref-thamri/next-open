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
shipped=$(mktemp)
trap 'rm -rf "$incoming" "$shipped"' EXIT
tar -xf - -C "$incoming"
[[ -f $incoming/docker-compose.yml && -f $incoming/package.json ]] || { echo "input is not the repo" >&2; exit 65; }
(cd "$incoming" && find . \( -type f -o -type l \) -print | LC_ALL=C sort) >"$shipped"
cp -a "$incoming/." "$APP_DIR/"

# Files the previous deploy shipped that this one does not were deleted from the repo; remove them so they stop
# reaching Docker builds. Files made on the server (.env) were never shipped, so they are never on the list.
manifest="$APP_DIR/.deployed-files"
if [[ -f $manifest ]]; then
    LC_ALL=C comm -23 "$manifest" "$shipped" | while IFS= read -r path; do rm -f -- "$APP_DIR/$path"; done
fi
cp "$shipped" "$manifest"

cd "$APP_DIR"
docker compose up -d --build --remove-orphans

container=$(docker compose ps -q "$SERVICE")
for _ in $(seq 1 36); do
    status=$(docker inspect --format '{{.State.Health.Status}}' "$container")
    if [[ $status == healthy ]]; then
        echo "deployed: $SERVICE is healthy"
        # Every build leaves cache and an untagged old image behind. Both projects on this server build here, so cap
        # the shared build cache by size (enough for fast rebuilds) rather than by age.
        docker builder prune -f --max-used-space 3gb >/dev/null || true
        docker image prune -f >/dev/null || true
        exit 0
    fi
    sleep 5
done
echo "$SERVICE did not become healthy within 3 minutes (last status: $status)" >&2
docker compose logs --tail=50 "$SERVICE" >&2
exit 1
