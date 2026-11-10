import { cents, dollarsToCents, type Cents } from "../core/money.js";
import type { Account, Position } from "../core/types.js";
import type { AppDeps } from "./deps.js";

export interface BrokerState {
    account: Account;
    positions: Position[];
}

/**
 * Reads account and positions from the broker (the source of truth) and stores any new fills. The reserved cash
 * from the risk settings is taken off the account here, the one place it is read.
 */
export async function syncBroker(deps: Pick<AppDeps, "broker" | "repos" | "config">): Promise<BrokerState> {
    const { broker, repos, config } = deps;
    const [account, positions, latest] = await Promise.all([
        broker.getAccount(),
        broker.getPositions(),
        repos.fills.latest(),
    ]);
    const fills = await broker.getFills(latest?.time ?? new Date(0));
    await repos.fills.saveMany(fills);
    return { account: withoutReserve(account, dollarsToCents(config.risk.reservedCashUsd)), positions };
}

/** The account as Next Open may trade it: the reserve is left out of equity, cash and the previous close alike. */
export function withoutReserve(account: Account, reserve: Cents): Account {
    return {
        equity: cents(account.equity - reserve),
        cash: cents(account.cash - reserve),
        previousCloseEquity: cents(account.previousCloseEquity - reserve),
    };
}
