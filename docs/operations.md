# Running and deploying

## Keys

Copy `.env.example` to `.env` and fill it in. Each line there says what it is for.

| Key                      | Where from                                                   |
| ------------------------ | ------------------------------------------------------------ |
| `ALPACA_PAPER_*`         | Alpaca dashboard, Paper Trading, API Keys                    |
| `FMP_API_KEY`            | Financial Modeling Prep; the free plan is enough             |
| `ANTHROPIC_API_KEY`      | Anthropic console; `ANTHROPIC_MODEL` picks the model         |
| `TELEGRAM_TOKEN`         | BotFather, for Next Open's own Telegram account              |
| `TELEGRAM_OWNER_CHAT_ID` | Your private chat with that account; no other chat is served |

Next Open checks the config at startup and refuses to start if anything is wrong, listing every problem at once.

## Settings

Risk limits, universe filters and tax rates have defaults in [`src/config/schema.ts`](../src/config/schema.ts). To
change any of them, point `CONFIG_PATH` at a JSON file with only the values you want to change:

```json
{ "risk": { "maxPositions": 10 }, "universe": { "minMarketCapUsd": 5000000000 } }
```

## Going live

Live trading starts only after the go-live rules pass ([ADR 0003](adr/0003-forward-testing-only.md)), and then in
small steps:

1. Open and fund an Alpaca live account and create live API keys.
2. Set `ALPACA_LIVE_KEY_ID`, `ALPACA_LIVE_SECRET_KEY` and `TRADING_MODE=live`, and restart.
3. To trade only part of the money at first, set `reservedCashUsd` in the settings file, for example
   `{ "risk": { "reservedCashUsd": 5000 } }`. That amount is taken off equity, cash and the previous close
   everywhere, so position sizes, the risk limits, the daily loss check, the reports and the benchmark see only the
   money being traded. `/status` shows the reserve on its own line. Lower it to trade more.
4. Send `/golive` in Telegram. It is refused until the go-live rules pass.
5. Each evening's orders now wait for an Approve tap before 09:25 New York time (15:25 in Denmark); a reminder
   comes at 06:00 New York time.

Things that work differently with real money:

- At startup Next Open sets the account's margin to 1× and switches short selling off. Alpaca calls such an
  account limited margin: it may buy with the unsettled proceeds of a sale without borrowing
  ([limited margin agreement](https://files.alpaca.markets/disclosures/library/SupplementalLimitedMarginAgreement.pdf)),
  so selling and buying at the same open works. FINRA has abolished the pattern day trader rule and its $25,000
  minimum ([Alpaca](https://docs.alpaca.markets/us/docs/intraday-margin-rule-for-non-leverage-margin-accounts)),
  though a broker may keep house limits of its own.
- Alpaca charges no commission. The SEC and FINRA fees on sells are charged once a day as separate `FEE` entries
  and are already taken off the equity the broker reports, which is what returns and the go-live rules use. The
  "Fees" line in `/report` counts only fees attached to fills, so it stays at $0.00 with Alpaca.

## Scripts

| Script                               | What it does                                                       |
| ------------------------------------ | ------------------------------------------------------------------ |
| `npm run check`                      | Everything CI runs except Docker: format, lint, types, knip, tests |
| `npm test` / `npm run test:coverage` | The tests, with a coverage report                                  |
| `npm run dry-run`                    | One evening analysis on live data with an in-memory broker         |
| `npm run dev`                        | The scheduler and Telegram, restarting on changes                  |
| `npm run build && npm start`         | Production build and start                                         |
| `npm run screenshots`                | Redraws the README images from demo data (needs Google Chrome)     |

## Dry run

`npm run dry-run` runs one evening analysis against real market data, news and the AI, with a fake $100,000 broker
and messages printed instead of sent. It takes an optional date (`npm run dry-run -- 2026-11-06`); the default is
the latest trading day that has closed.

The first run builds the liquid list in a separate cache database, `data/dry-run-cache.db`. Within FMP's free quota
that takes a few days, so rerun it daily until the list is complete. `--quick` skips the list and uses 30 large US
stocks instead, for a same-day check. The cost of the AI call is printed at the end.

## Deployment

One container on a small VPS with Docker Compose and SQLite on a named volume.

Merges to `main` deploy once CI passes ([deploy.yml](../.github/workflows/deploy.yml)). GitHub Actions streams the
tree over SSH with a key that can only run [server-deploy.sh](../scripts/server-deploy.sh). That script refuses to
deploy around the open and the post-close jobs, and the workflow tries again every five minutes until the window has
passed. It unpacks aside, removes files deleted from the repo since the last deploy, rebuilds, and fails the deploy
unless the container reports healthy within three minutes. The workflows run with a read-only token and actions
pinned to commit SHAs, which Dependabot keeps current.

`server-deploy.sh` is installed on the server as `~/bin/deploy`. After changing it, copy it there again by hand.

Manual deploy on the server:

```sh
docker compose up -d --build
docker compose ps        # healthy within about two minutes
docker compose logs -f
```

## Backups and monitoring

- A nightly online backup of the SQLite database runs at 02:00 New York time into `BACKUP_DIR`; 14 days are kept.
- The scheduler touches a heartbeat file every minute, and the Docker health check fails when it is older than
  three minutes.
- `HEALTHCHECK_PING_URL` (for example healthchecks.io, with a 5-minute period) is pinged while the scheduler runs,
  so you hear about it when the whole server goes quiet.
- A restart without a clean shutdown sends a Telegram alert, at most once an hour.

## Read-only access

[`scripts/read-access/`](../scripts/read-access/) sets up a second SSH key that can only run one read-only SQL query
or read the container logs, for checks without the owner's own login:

```sh
echo "select type, status, started_at from runs order by started_at desc limit 5" | ssh next-open-read no-db-read
ssh next-open-read no-logs 2h
```
