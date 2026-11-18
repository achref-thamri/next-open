import type { Ticker } from "../../core/types.js";
import type { CompanyProfile, Fundamentals } from "../../ports/fundamentals.js";
import { FailureInjector } from "./failures.js";

/** Profiles from a map, with a request budget like the vendor's free tier. */
export class FakeFundamentals implements Fundamentals {
    readonly failures = new FailureInjector();
    readonly profiles = new Map<Ticker, CompanyProfile>();
    requests = 0;

    constructor(private readonly dailyBudget = Number.POSITIVE_INFINITY) {}

    async getProfile(ticker: Ticker): Promise<CompanyProfile | undefined> {
        await this.failures.check("getProfile");
        if (!this.spend(1)) return undefined;
        const profile = this.profiles.get(ticker);
        return profile && { ...profile };
    }

    remainingRequests(): Promise<number> {
        return Promise.resolve(Math.max(0, this.dailyBudget - this.requests));
    }

    private spend(count: number): boolean {
        if (this.requests + count > this.dailyBudget) return false;
        this.requests += count;
        return true;
    }
}
