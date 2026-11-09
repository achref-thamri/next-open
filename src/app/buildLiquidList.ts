import { tradingDateOf, type Ticker, type TradingDate } from "../core/types.js";
import { barFeatures } from "../core/universe/features.js";
import {
    buildLiquidList as filterLiquid,
    listedExchange,
    minDollarVolume,
    minPrice,
    type SecurityFacts,
} from "../core/universe/filters.js";
import type { CachedProfile } from "../ports/repositories.js";
import { addDays } from "./calendar.js";
import type { AppDeps } from "./deps.js";
import { runJob, skip, type JobResult } from "./runJob.js";

const HISTORY_DAYS = 45;
const PROFILE_MAX_AGE_MS = 30 * 86_400_000;

/** The Sunday that starts the week of `date`; it identifies the weekly list. */
export function weekOf(date: TradingDate): TradingDate {
    const day = new Date(`${date}T00:00:00Z`).getUTCDay();
    return addDays(date, -day);
}

/**
 * The weekly liquid list (spec §5). Runs daily but builds at most one complete list per week: price and dollar
 * volume from SIP bars filter the ~11,000 tradable assets first, then company profiles (ETF flag, market cap)
 * from the cache, fetching missing ones within FMP's daily budget. While profiles are missing the list is
 * saved as incomplete and the next day's run continues. Profiles are fetched most traded first, and the evening
 * job uses the list while it fills.
 */
export async function buildLiquidList(deps: AppDeps): Promise<JobResult> {
    const today = tradingDateOf(deps.clock.now());
    const week = weekOf(today);
    return runJob(deps, "liquid_list", today, async () => {
        const latest = await deps.repos.liquidLists.latest();
        if (latest?.complete && latest.date === week) return skip(`the list for the week of ${week} is complete`);
        return build(deps, today, week);
    });
}

async function build(deps: AppDeps, today: TradingDate, week: TradingDate): Promise<JobResult> {
    const { marketData, fundamentals, repos, config, logger, clock } = deps;
    const limits = config.universe;

    const assets = await marketData.listTradableAssets();
    const bars = await marketData.getDailyBars(
        assets.map((a) => a.ticker),
        addDays(today, -HISTORY_DAYS),
        today,
    );

    // Cheap filters first, so FMP is only asked about stocks that can make the list.
    const liquid: Omit<SecurityFacts, "kind" | "marketCapUsd">[] = [];
    for (const asset of assets) {
        const features = barFeatures(bars.get(asset.ticker) ?? [], limits.avgVolumeDays);
        if (!features) continue;
        const facts = {
            ticker: asset.ticker,
            exchange: asset.exchange,
            kind: "common_stock" as const,
            marketCapUsd: 0,
            ...features,
        };
        if (listedExchange(facts, limits) ?? minPrice(facts, limits) ?? minDollarVolume(facts, limits)) continue;
        liquid.push(facts);
    }

    // Most traded first, so the profiles FMP's daily budget buys go to the stocks most likely to be traded.
    liquid.sort((a, b) => b.avgDollarVolumeUsd - a.avgDollarVolumeUsd);
    const tickers = liquid.map((s) => s.ticker);
    const cached = await repos.profiles.getMany(tickers);
    const now = clock.now();
    const stale = tickers.filter((t) => {
        const p = cached.get(t);
        return !p || now.getTime() - p.fetchedAt.getTime() >= PROFILE_MAX_AGE_MS;
    });

    // Refresh market caps of fresh profiles in batches (cheap), then fetch missing or stale profiles one by one.
    const staleSet = new Set(stale);
    const fresh = tickers.filter((t) => !staleSet.has(t));
    const caps = await fundamentals.getMarketCaps(fresh);
    for (const [ticker, marketCapUsd] of caps) {
        const profile = cached.get(ticker);
        if (profile && profile.marketCapUsd !== marketCapUsd) await repos.profiles.save({ ...profile, marketCapUsd });
    }
    const profiles = new Map<Ticker, Pick<CachedProfile, "kind" | "marketCapUsd">>(cached);
    for (const [ticker, marketCapUsd] of caps) {
        const profile = profiles.get(ticker);
        if (profile) profiles.set(ticker, { ...profile, marketCapUsd });
    }
    let missing = 0;
    for (const ticker of stale) {
        if ((await fundamentals.remainingRequests()) <= 0) {
            missing++;
            continue;
        }
        const profile = await fundamentals.getProfile(ticker);
        if (!profile) {
            missing++;
            continue;
        }
        profiles.set(ticker, profile);
        await repos.profiles.save({ ...profile, fetchedAt: now });
    }

    const known = liquid.flatMap((s) => {
        const p = profiles.get(s.ticker);
        return p ? [{ ...s, kind: p.kind, marketCapUsd: p.marketCapUsd }] : [];
    });
    const list = filterLiquid(known, limits);
    const complete = missing === 0;
    await repos.liquidLists.save({ date: week, tickers: list.tickers, complete });
    logger.info(
        { assets: assets.length, liquid: liquid.length, listed: list.tickers.length, missing },
        "liquid list built",
    );

    if (!complete) {
        return skip(
            `${list.tickers.length} stocks so far; ${missing} profiles still to fetch (FMP daily budget), continuing tomorrow`,
        );
    }
    await deps.notifier.send(`📋 Weekly list ready: ${list.tickers.length} liquid US stocks for the week of ${week}.`);
    return { status: "succeeded", message: `${list.tickers.length} stocks` };
}
