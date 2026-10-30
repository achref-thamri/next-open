export const initial = /* sql */ `
CREATE TABLE runs (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    trade_date TEXT NOT NULL,
    started_at TEXT NOT NULL,
    finished_at TEXT,
    status TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'skipped', 'failed')),
    error TEXT,
    explained INTEGER NOT NULL DEFAULT 0
) STRICT;
CREATE INDEX runs_type_date ON runs (type, trade_date, started_at);
CREATE INDEX runs_failed ON runs (status, explained, started_at);

CREATE TABLE candidates (
    run_id TEXT NOT NULL REFERENCES runs (id),
    ticker TEXT NOT NULL,
    features TEXT NOT NULL,
    passed INTEGER NOT NULL,
    reject_reason TEXT,
    PRIMARY KEY (run_id, ticker)
) STRICT;

CREATE TABLE llm_calls (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES runs (id),
    model TEXT NOT NULL,
    system_prompt TEXT NOT NULL,
    user_prompt TEXT NOT NULL,
    response TEXT NOT NULL,
    input_tokens INTEGER NOT NULL,
    output_tokens INTEGER NOT NULL,
    cost_usd REAL NOT NULL,
    duration_ms INTEGER NOT NULL
) STRICT;

CREATE TABLE decisions (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES runs (id),
    llm_call_id TEXT NOT NULL REFERENCES llm_calls (id),
    trade_date TEXT NOT NULL,
    ticker TEXT NOT NULL,
    action TEXT NOT NULL CHECK (action IN ('buy', 'sell', 'hold')),
    target_weight REAL NOT NULL,
    confidence INTEGER NOT NULL,
    stop_loss_pct REAL NOT NULL,
    take_profit_pct REAL NOT NULL,
    horizon_days INTEGER NOT NULL,
    reasoning TEXT NOT NULL,
    created_at TEXT NOT NULL
) STRICT;
CREATE INDEX decisions_ticker ON decisions (ticker, created_at);
CREATE INDEX decisions_created ON decisions (created_at);

CREATE TABLE proposals (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES runs (id),
    trade_date TEXT NOT NULL,
    ticker TEXT NOT NULL,
    side TEXT NOT NULL CHECK (side IN ('buy', 'sell')),
    requested_qty INTEGER NOT NULL,
    qty INTEGER NOT NULL,
    limit_price INTEGER NOT NULL,
    target_weight REAL NOT NULL,
    stop_loss_pct REAL,
    take_profit_pct REAL,
    confidence INTEGER NOT NULL,
    reasoning TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected', 'expired', 'executed')),
    risk_notes TEXT NOT NULL
) STRICT;
CREATE INDEX proposals_date_status ON proposals (trade_date, status);

CREATE TABLE orders (
    client_order_id TEXT PRIMARY KEY,
    broker_order_id TEXT NOT NULL UNIQUE,
    proposal_id TEXT REFERENCES proposals (id),
    trade_date TEXT NOT NULL,
    ticker TEXT NOT NULL,
    side TEXT NOT NULL CHECK (side IN ('buy', 'sell')),
    role TEXT NOT NULL,
    qty INTEGER NOT NULL,
    filled_qty INTEGER NOT NULL,
    filled_avg_price INTEGER,
    limit_price INTEGER,
    status TEXT NOT NULL,
    submitted_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
) STRICT;
CREATE INDEX orders_date_status ON orders (trade_date, status);

CREATE TABLE fills (
    id TEXT PRIMARY KEY,
    order_id TEXT NOT NULL,
    ticker TEXT NOT NULL,
    side TEXT NOT NULL CHECK (side IN ('buy', 'sell')),
    qty INTEGER NOT NULL,
    price INTEGER NOT NULL,
    fee INTEGER NOT NULL,
    trade_date TEXT NOT NULL,
    time TEXT NOT NULL
) STRICT;
CREATE INDEX fills_time ON fills (time);

CREATE TABLE equity_snapshots (
    date TEXT PRIMARY KEY,
    equity INTEGER NOT NULL,
    cash INTEGER NOT NULL,
    benchmark_value INTEGER NOT NULL
) STRICT;

CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
) STRICT;

CREATE TABLE profiles (
    ticker TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    kind TEXT NOT NULL,
    market_cap_usd REAL,
    fetched_at TEXT NOT NULL
) STRICT;

CREATE TABLE liquid_lists (
    date TEXT PRIMARY KEY,
    tickers TEXT NOT NULL,
    complete INTEGER NOT NULL
) STRICT;

CREATE TABLE api_usage (
    api TEXT NOT NULL,
    day TEXT NOT NULL,
    count INTEGER NOT NULL,
    PRIMARY KEY (api, day)
) STRICT;
`;
