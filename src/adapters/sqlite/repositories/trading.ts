import type { Cents } from "../../../core/money.js";
import type { Proposal, ProposalStatus, Side, Ticker, TradingDate } from "../../../core/types.js";
import type { BrokerFill, OrderRole, OrderStatus } from "../../../ports/broker.js";
import type {
    FillsRepository,
    OrderRecord,
    OrdersRepository,
    ProposalsRepository,
} from "../../../ports/repositories.js";
import type { Db } from "../db.js";
import { fromIso, orUndefined, placeholders, promised, toIso } from "./util.js";

interface ProposalRow {
    id: string;
    run_id: string;
    trade_date: string;
    ticker: string;
    side: string;
    requested_qty: number;
    qty: number;
    limit_price: number;
    previous_close: number;
    target_weight: number;
    stop_loss_pct: number | null;
    take_profit_pct: number | null;
    confidence: number;
    reasoning: string;
    status: string;
    risk_notes: string;
}

const toProposal = (row: ProposalRow): Proposal => ({
    id: row.id,
    runId: row.run_id,
    tradeDate: row.trade_date as TradingDate,
    ticker: row.ticker as Ticker,
    side: row.side as Side,
    requestedQty: row.requested_qty,
    qty: row.qty,
    limitPrice: row.limit_price as Cents,
    previousClose: row.previous_close as Cents,
    targetWeight: row.target_weight,
    stopLossPct: orUndefined(row.stop_loss_pct),
    takeProfitPct: orUndefined(row.take_profit_pct),
    confidence: row.confidence as Proposal["confidence"],
    reasoning: row.reasoning,
    status: row.status as ProposalStatus,
    riskNotes: JSON.parse(row.risk_notes) as string[],
});

export class SqliteProposalsRepository implements ProposalsRepository {
    constructor(private readonly db: Db) {}

    saveMany(proposals: readonly Proposal[]): Promise<void> {
        return promised(() => {
            const insert = this.db.prepare(
                `INSERT INTO proposals (id, run_id, trade_date, ticker, side, requested_qty, qty, limit_price,
                    previous_close, target_weight, stop_loss_pct, take_profit_pct, confidence, reasoning, status,
                    risk_notes)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            );
            this.db.transaction(() => {
                for (const p of proposals) {
                    insert.run(
                        p.id,
                        p.runId,
                        p.tradeDate,
                        p.ticker,
                        p.side,
                        p.requestedQty,
                        p.qty,
                        p.limitPrice,
                        p.previousClose,
                        p.targetWeight,
                        p.stopLossPct ?? null,
                        p.takeProfitPct ?? null,
                        p.confidence,
                        p.reasoning,
                        p.status,
                        JSON.stringify(p.riskNotes),
                    );
                }
            })();
        });
    }

    get(id: string): Promise<Proposal | undefined> {
        return promised(() => {
            const row = this.db.prepare("SELECT * FROM proposals WHERE id = ?").get(id) as ProposalRow | undefined;
            return row && toProposal(row);
        });
    }

    list(filter: { tradeDate?: TradingDate; statuses?: readonly ProposalStatus[] }): Promise<Proposal[]> {
        return promised(() => {
            const where: string[] = [];
            const params: string[] = [];
            if (filter.tradeDate !== undefined) {
                where.push("trade_date = ?");
                params.push(filter.tradeDate);
            }
            if (filter.statuses !== undefined) {
                if (filter.statuses.length === 0) return [];
                where.push(`status IN (${placeholders(filter.statuses.length)})`);
                params.push(...filter.statuses);
            }
            const sql = `SELECT * FROM proposals ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY id`;
            return (this.db.prepare(sql).all(...params) as ProposalRow[]).map(toProposal);
        });
    }

    transition(id: string, from: readonly ProposalStatus[], to: ProposalStatus): Promise<boolean> {
        return promised(() => {
            if (from.length === 0) return false;
            const { changes } = this.db
                .prepare(`UPDATE proposals SET status = ? WHERE id = ? AND status IN (${placeholders(from.length)})`)
                .run(to, id, ...from);
            return changes === 1;
        });
    }

    updateRisk(id: string, qty: number, riskNotes: readonly string[]): Promise<void> {
        return promised(() => {
            this.db
                .prepare("UPDATE proposals SET qty = ?, risk_notes = ? WHERE id = ?")
                .run(qty, JSON.stringify(riskNotes), id);
        });
    }
}

interface OrderRow {
    client_order_id: string;
    broker_order_id: string;
    proposal_id: string | null;
    trade_date: string;
    ticker: string;
    side: string;
    role: string;
    qty: number;
    filled_qty: number;
    filled_avg_price: number | null;
    limit_price: number | null;
    status: string;
    submitted_at: string;
    updated_at: string;
}

const toOrder = (row: OrderRow): OrderRecord => ({
    clientOrderId: row.client_order_id,
    brokerOrderId: row.broker_order_id,
    proposalId: orUndefined(row.proposal_id),
    tradeDate: row.trade_date as TradingDate,
    ticker: row.ticker as Ticker,
    side: row.side as Side,
    role: row.role as OrderRole,
    qty: row.qty,
    filledQty: row.filled_qty,
    filledAvgPrice: orUndefined(row.filled_avg_price) as Cents | undefined,
    limitPrice: orUndefined(row.limit_price) as Cents | undefined,
    status: row.status as OrderStatus,
    submittedAt: fromIso(row.submitted_at),
    updatedAt: fromIso(row.updated_at),
});

export class SqliteOrdersRepository implements OrdersRepository {
    constructor(private readonly db: Db) {}

    upsert(order: OrderRecord): Promise<void> {
        return promised(() => {
            this.db
                .prepare(
                    `INSERT INTO orders (client_order_id, broker_order_id, proposal_id, trade_date, ticker, side, role,
                        qty, filled_qty, filled_avg_price, limit_price, status, submitted_at, updated_at)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                     ON CONFLICT (client_order_id) DO UPDATE SET
                        broker_order_id = excluded.broker_order_id, qty = excluded.qty,
                        filled_qty = excluded.filled_qty, filled_avg_price = excluded.filled_avg_price,
                        limit_price = excluded.limit_price, status = excluded.status, updated_at = excluded.updated_at`,
                )
                .run(
                    order.clientOrderId,
                    order.brokerOrderId,
                    order.proposalId ?? null,
                    order.tradeDate,
                    order.ticker,
                    order.side,
                    order.role,
                    order.qty,
                    order.filledQty,
                    order.filledAvgPrice ?? null,
                    order.limitPrice ?? null,
                    order.status,
                    toIso(order.submittedAt),
                    toIso(order.updatedAt),
                );
        });
    }

    getByClientOrderId(clientOrderId: string): Promise<OrderRecord | undefined> {
        return promised(() => {
            const row = this.db.prepare("SELECT * FROM orders WHERE client_order_id = ?").get(clientOrderId) as
                OrderRow | undefined;
            return row && toOrder(row);
        });
    }

    list(filter: { tradeDate?: TradingDate; statuses?: readonly OrderStatus[] }): Promise<OrderRecord[]> {
        return promised(() => {
            const where: string[] = [];
            const params: string[] = [];
            if (filter.tradeDate !== undefined) {
                where.push("trade_date = ?");
                params.push(filter.tradeDate);
            }
            if (filter.statuses !== undefined) {
                if (filter.statuses.length === 0) return [];
                where.push(`status IN (${placeholders(filter.statuses.length)})`);
                params.push(...filter.statuses);
            }
            const sql = `SELECT * FROM orders ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY submitted_at, client_order_id`;
            return (this.db.prepare(sql).all(...params) as OrderRow[]).map(toOrder);
        });
    }
}

interface FillRow {
    id: string;
    order_id: string;
    ticker: string;
    side: string;
    qty: number;
    price: number;
    fee: number;
    trade_date: string;
    time: string;
}

const toFill = (row: FillRow): BrokerFill => ({
    id: row.id,
    orderId: row.order_id,
    ticker: row.ticker as Ticker,
    side: row.side as Side,
    qty: row.qty,
    price: row.price as Cents,
    fee: row.fee as Cents,
    date: row.trade_date as TradingDate,
    time: fromIso(row.time),
});

export class SqliteFillsRepository implements FillsRepository {
    constructor(private readonly db: Db) {}

    saveMany(fills: readonly BrokerFill[]): Promise<void> {
        return promised(() => {
            const insert = this.db.prepare(
                `INSERT INTO fills (id, order_id, ticker, side, qty, price, fee, trade_date, time)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (id) DO NOTHING`,
            );
            this.db.transaction(() => {
                for (const f of fills) {
                    insert.run(f.id, f.orderId, f.ticker, f.side, f.qty, f.price, f.fee, f.date, toIso(f.time));
                }
            })();
        });
    }

    list(): Promise<BrokerFill[]> {
        return promised(() =>
            (this.db.prepare("SELECT * FROM fills ORDER BY time, id").all() as FillRow[]).map(toFill),
        );
    }

    latest(): Promise<BrokerFill | undefined> {
        return promised(() => {
            const row = this.db.prepare("SELECT * FROM fills ORDER BY time DESC, id DESC LIMIT 1").get() as
                FillRow | undefined;
            return row && toFill(row);
        });
    }
}
