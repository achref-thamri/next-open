export const shadowPortfolios = /* sql */ `
CREATE TABLE shadow_portfolios (
    strategy TEXT PRIMARY KEY,
    cash INTEGER NOT NULL,
    positions TEXT NOT NULL,
    start_date TEXT NOT NULL,
    start_value INTEGER NOT NULL,
    last_simulated TEXT
) STRICT;

CREATE TABLE shadow_orders (
    id TEXT PRIMARY KEY,
    strategy TEXT NOT NULL REFERENCES shadow_portfolios (strategy),
    trade_date TEXT NOT NULL,
    ticker TEXT NOT NULL,
    side TEXT NOT NULL CHECK (side IN ('buy', 'sell')),
    qty INTEGER NOT NULL,
    limit_price INTEGER NOT NULL,
    stop_loss_price INTEGER,
    take_profit_price INTEGER,
    reasoning TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending', 'filled', 'unfilled'))
) STRICT;
CREATE INDEX shadow_orders_day ON shadow_orders (strategy, trade_date);

CREATE TABLE shadow_fills (
    strategy TEXT NOT NULL REFERENCES shadow_portfolios (strategy),
    date TEXT NOT NULL,
    seq INTEGER NOT NULL,
    ticker TEXT NOT NULL,
    side TEXT NOT NULL CHECK (side IN ('buy', 'sell')),
    qty INTEGER NOT NULL,
    price INTEGER NOT NULL,
    reason TEXT NOT NULL,
    PRIMARY KEY (strategy, date, seq)
) STRICT;

CREATE TABLE shadow_snapshots (
    strategy TEXT NOT NULL REFERENCES shadow_portfolios (strategy),
    date TEXT NOT NULL,
    equity INTEGER NOT NULL,
    PRIMARY KEY (strategy, date)
) STRICT;
`;
