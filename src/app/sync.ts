import type { Account, Position } from "../core/types.js";
import type { AppDeps } from "./deps.js";

export interface BrokerState {
    account: Account;
    positions: Position[];
}

/** Reads account and positions from the broker (the source of truth) and stores any new fills. */
export async function syncBroker(deps: Pick<AppDeps, "broker" | "repos">): Promise<BrokerState> {
    const { broker, repos } = deps;
    const [account, positions, latest] = await Promise.all([
        broker.getAccount(),
        broker.getPositions(),
        repos.fills.latest(),
    ]);
    const fills = await broker.getFills(latest?.time ?? new Date(0));
    await repos.fills.saveMany(fills);
    return { account, positions };
}
