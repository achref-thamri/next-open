import { z } from "zod";
import { isTicker, tradingDateOf, type SecurityKind, type Ticker } from "../../core/types.js";
import { HttpError, PermanentError, RateLimitError } from "../../lib/errors.js";
import { requestJson, type Fetch } from "../../lib/http.js";
import type { Logger } from "../../lib/logger.js";
import { retry, type RetryOptions } from "../../lib/retry.js";
import type { Clock } from "../../ports/clock.js";
import type { CompanyProfile, Fundamentals } from "../../ports/fundamentals.js";
import type { ApiUsageRepository, CachedProfile, ProfilesRepository } from "../../ports/repositories.js";

const BASE_URL = "https://financialmodelingprep.com/stable";
const API = "fmp";
/** The free plan allows about 250 requests a day; keep a margin for manual checks. */
const FMP_DAILY_BUDGET = 240;
const PROFILE_MAX_AGE_MS = 30 * 86_400_000;

const profileSchema = z.array(
    z.object({
        symbol: z.string(),
        companyName: z.string().nullish(),
        marketCap: z.number().nullish(),
        isEtf: z.boolean(),
        isFund: z.boolean(),
    }),
);

export interface FmpOptions {
    apiKey: string;
    profiles: ProfilesRepository;
    usage: ApiUsageRepository;
    clock: Clock;
    logger: Logger;
    fetch?: Fetch;
    retry?: RetryOptions;
    dailyBudget?: number;
}

/**
 * Company profiles (including market cap) from Financial Modeling Prep. Profiles are cached in SQLite and refreshed
 * after 30 days; every request counts against a daily budget, and when it is used up the adapter answers from
 * the cache (or not at all) instead of calling the API. The API key travels in the query string, so URLs are
 * never logged or put in error messages.
 */
export class FmpFundamentals implements Fundamentals {
    private readonly budget: number;

    constructor(private readonly options: FmpOptions) {
        this.budget = options.dailyBudget ?? FMP_DAILY_BUDGET;
    }

    async getProfile(ticker: Ticker): Promise<CompanyProfile | undefined> {
        const cached = await this.options.profiles.get(ticker);
        const now = this.options.clock.now();
        if (cached && now.getTime() - cached.fetchedAt.getTime() < PROFILE_MAX_AGE_MS) return withoutDate(cached);
        if (!(await this.spend())) return cached && withoutDate(cached);

        const rows = await this.get("/profile", profileSchema, { symbol: toFmpSymbol(ticker) });
        if (rows === LIMIT_REACHED) return cached && withoutDate(cached);
        const row = rows[0];
        // Unknown to FMP: cache as "other" so the ticker is not looked up again every day.
        const profile: CachedProfile = {
            ticker,
            name: row?.companyName ?? ticker,
            kind: row ? kindOf(row) : "other",
            marketCapUsd: row?.marketCap ?? undefined,
            fetchedAt: now,
        };
        await this.options.profiles.save(profile);
        return withoutDate(profile);
    }

    async remainingRequests(): Promise<number> {
        return Math.max(0, this.budget - (await this.options.usage.get(API, this.today())));
    }

    /** Counts one request against today's budget; false when the budget is used up. */
    private async spend(): Promise<boolean> {
        if ((await this.remainingRequests()) <= 0) {
            this.options.logger.warn("FMP daily request budget used up");
            return false;
        }
        await this.options.usage.increment(API, this.today());
        return true;
    }

    private today(): string {
        return tradingDateOf(this.options.clock.now());
    }

    /**
     * FMP answers 429 once the plan's daily quota is spent, which also counts calls made outside this process.
     * Retrying would not help until tomorrow: the day's budget is marked as used and LIMIT_REACHED returned.
     */
    private async get<S extends z.ZodType>(
        path: string,
        schema: S,
        query: Record<string, string>,
    ): Promise<z.output<S> | typeof LIMIT_REACHED> {
        try {
            return await this.request(path, schema, query);
        } catch (error) {
            if (!(error instanceof RateLimitError)) throw error;
            const used = await this.options.usage.get(API, this.today());
            await this.options.usage.increment(API, this.today(), Math.max(0, this.budget - used));
            this.options.logger.warn("FMP daily limit reached; continuing tomorrow");
            return LIMIT_REACHED;
        }
    }

    private request<S extends z.ZodType>(path: string, schema: S, query: Record<string, string>): Promise<z.output<S>> {
        const params = new URLSearchParams({ ...query, apikey: this.options.apiKey });
        return retry(
            () =>
                requestJson({
                    url: `${BASE_URL}${path}?${params.toString()}`,
                    label: `FMP ${path}`,
                    schema,
                    ...(this.options.fetch ? { fetch: this.options.fetch } : {}),
                }).catch((error: unknown) => {
                    // A daily quota, not a burst limit: fail fast instead of backing off.
                    if (error instanceof RateLimitError) throw new RateLimitAbort(error.message, { cause: error });
                    if (error instanceof HttpError && error.status === 402) {
                        throw new HttpError(`FMP ${path}: not included in the current plan`, 402, "");
                    }
                    throw error;
                }),
            this.options.retry,
        ).catch((error: unknown) => {
            throw error instanceof RateLimitAbort && error.cause instanceof RateLimitError ? error.cause : error;
        });
    }
}

const LIMIT_REACHED = Symbol("FMP daily limit reached");

/** Carries a 429 through `retry` without retrying it. */
class RateLimitAbort extends PermanentError {}

function kindOf(row: { isEtf: boolean; isFund: boolean }): SecurityKind {
    if (row.isEtf) return "etf";
    if (row.isFund) return "fund";
    return "common_stock";
}

function withoutDate({ fetchedAt: _, ...profile }: CachedProfile): CompanyProfile {
    return profile;
}

/** FMP writes share classes with a dash ("BRK-B"), Alpaca with a dot ("BRK.B"). */
export function toFmpSymbol(ticker: Ticker): string {
    return ticker.replace(".", "-");
}

export function fromFmpSymbol(symbol: string): Ticker | undefined {
    const ticker = symbol.replace("-", ".");
    return isTicker(ticker) ? ticker : undefined;
}
