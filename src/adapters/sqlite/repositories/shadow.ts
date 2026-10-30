import { cents, type Cents } from "../../../core/money.js";
import type { FillReason, SimulatedFill, VirtualPortfolio } from "../../../core/simulation.js";
import type { Side, Ticker, TradingDate } from "../../../core/types.js";
import type {
    ShadowAccount,
    ShadowDay,
    ShadowOrder,
    ShadowRepository,
    StrategyId,
} from "../../../ports/repositories.js";
import type { Db } from "../db.js";
import { orUndefined, promised } from "./util.js";

interface AccountRow {
    strategy: string;
    cash: number;
    positions: string;
    start_date: string;
    start_value: number;
    last_simulated: string | null;
}

interface OrderRow {
    id: string;
    ticker: string;
    side: string;
    qty: number;
    limit_price: number;
    stop_loss_price: number | null;
    take_profit_price: number | null;
    reasoning: string;
    status: string;
}

export class SqliteShadowRepository implements ShadowRepository {
    constructor(private readonly db: Db) {}

    getAccount(strategy: StrategyId): Promise<ShadowAccount | undefined> {
        return promised(() => {
            const row = this.db.prepare("SELECT * FROM shadow_portfolios WHERE strategy = ?").get(strategy) as
                AccountRow | undefined;
            return (
                row && {
                    strategy,
                    portfolio: {
                        cash: row.cash as Cents,
                        positions: JSON.parse(row.positions) as VirtualPortfolio["positions"],
                    },
                    startDate: row.start_date as TradingDate,
                    startValue: row.start_value as Cents,
                    lastSimulated: orUndefined(row.last_simulated) as TradingDate | undefined,
                }
            );
        });
    }

    openAccount(account: Omit<ShadowAccount, "lastSimulated">): Promise<void> {
        return promised(() => {
            this.db
                .prepare(
                    `INSERT INTO shadow_portfolios (strategy, cash, positions, start_date, start_value)
                     VALUES (?, ?, ?, ?, ?) ON CONFLICT (strategy) DO NOTHING`,
                )
                .run(
                    account.strategy,
                    account.portfolio.cash,
                    JSON.stringify(account.portfolio.positions),
                    account.startDate,
                    account.startValue,
                );
        });
    }

    saveOrders(strategy: StrategyId, tradeDate: TradingDate, orders: readonly ShadowOrder[]): Promise<void> {
        return promised(() => {
            const insert = this.db.prepare(
                `INSERT INTO shadow_orders (id, strategy, trade_date, ticker, side, qty, limit_price, stop_loss_price,
                    take_profit_price, reasoning, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            );
            this.db.transaction(() => {
                this.db
                    .prepare("DELETE FROM shadow_orders WHERE strategy = ? AND trade_date = ? AND status = 'pending'")
                    .run(strategy, tradeDate);
                for (const o of orders) {
                    insert.run(
                        o.id,
                        strategy,
                        tradeDate,
                        o.ticker,
                        o.side,
                        o.qty,
                        o.limitPrice,
                        o.stopLossPrice ?? null,
                        o.takeProfitPrice ?? null,
                        o.reasoning,
                        o.status,
                    );
                }
            })();
        });
    }

    pendingOrders(strategy: StrategyId, tradeDate: TradingDate): Promise<ShadowOrder[]> {
        return promised(() =>
            (
                this.db
                    .prepare(
                        "SELECT * FROM shadow_orders WHERE strategy = ? AND trade_date = ? AND status = 'pending' ORDER BY id",
                    )
                    .all(strategy, tradeDate) as OrderRow[]
            ).map((r) => ({
                id: r.id,
                ticker: r.ticker as Ticker,
                side: r.side as Side,
                qty: r.qty,
                limitPrice: r.limit_price as Cents,
                stopLossPrice: orUndefined(r.stop_loss_price) as Cents | undefined,
                takeProfitPrice: orUndefined(r.take_profit_price) as Cents | undefined,
                reasoning: r.reasoning,
                status: r.status as ShadowOrder["status"],
            })),
        );
    }

    recordDay(day: ShadowDay): Promise<boolean> {
        return promised(() =>
            this.db.transaction(() => {
                const { changes } = this.db
                    .prepare(
                        `UPDATE shadow_portfolios SET cash = ?, positions = ?, last_simulated = ?
                         WHERE strategy = ? AND (last_simulated IS NULL OR last_simulated < ?)`,
                    )
                    .run(day.portfolio.cash, JSON.stringify(day.portfolio.positions), day.date, day.strategy, day.date);
                if (changes === 0) return false;
                const insertFill = this.db.prepare(
                    "INSERT INTO shadow_fills (strategy, date, seq, ticker, side, qty, price, reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                );
                day.fills.forEach((f, seq) =>
                    insertFill.run(day.strategy, day.date, seq, f.ticker, f.side, f.qty, f.price, f.reason),
                );
                const filled = this.db.prepare("UPDATE shadow_orders SET status = 'filled' WHERE id = ?");
                for (const id of day.filledOrderIds) filled.run(id);
                this.db
                    .prepare(
                        "UPDATE shadow_orders SET status = 'unfilled' WHERE strategy = ? AND trade_date = ? AND status = 'pending'",
                    )
                    .run(day.strategy, day.date);
                this.db
                    .prepare(
                        "INSERT INTO shadow_snapshots (strategy, date, equity) VALUES (?, ?, ?) ON CONFLICT (strategy, date) DO UPDATE SET equity = excluded.equity",
                    )
                    .run(day.strategy, day.date, day.equity);
                return true;
            })(),
        );
    }

    fills(strategy: StrategyId): Promise<(SimulatedFill & { strategy: StrategyId })[]> {
        return promised(() =>
            (
                this.db.prepare("SELECT * FROM shadow_fills WHERE strategy = ? ORDER BY date, seq").all(strategy) as {
                    date: string;
                    ticker: string;
                    side: string;
                    qty: number;
                    price: number;
                    reason: string;
                }[]
            ).map((r) => ({
                strategy,
                ticker: r.ticker as Ticker,
                side: r.side as Side,
                qty: r.qty,
                price: r.price as Cents,
                fee: cents(0),
                date: r.date as TradingDate,
                reason: r.reason as FillReason,
            })),
        );
    }

    snapshots(strategy: StrategyId): Promise<{ date: TradingDate; equity: Cents }[]> {
        return promised(() =>
            (
                this.db
                    .prepare("SELECT date, equity FROM shadow_snapshots WHERE strategy = ? ORDER BY date")
                    .all(strategy) as {
                    date: string;
                    equity: number;
                }[]
            ).map((r) => ({ date: r.date as TradingDate, equity: r.equity as Cents })),
        );
    }
}
