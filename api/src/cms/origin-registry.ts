import { Inject, Injectable, Logger, type Provider } from '@nestjs/common';

/**
 * Injection token for the origin policy this instance enforces.
 *
 * Injected rather than read from the environment so an embedding host — the
 * Electron `createServer(opts)` bootstrap — can hand the API both its initial
 * allowlist and a callback that asks the user, in a native dialog, whether an
 * unknown CMS may talk to this machine. The same pattern as LOCAL_API_TOKEN.
 */
export const ORIGIN_POLICY = Symbol('ORIGIN_POLICY');

export interface OriginPolicy {
    /** Origins trusted without asking. Compared exactly, after normalisation. */
    allowedOrigins?: string[];
    /**
     * Origins the user has refused. Remembered so a site that keeps trying
     * cannot turn "no" into a dialog every few seconds until someone clicks the
     * wrong button.
     */
    deniedOrigins?: string[];
    /**
     * Consulted once per unknown origin. Resolving true is a trust-on-first-use
     * grant: the origin is remembered for the life of the process.
     *
     * Absent — the default until the Electron host provides one — means unknown
     * origins are simply refused, so a headless run cannot be talked into
     * trusting anything it was not configured with.
     */
    originApprover?: (origin: string) => Promise<boolean>;
    /**
     * Called whenever a decision changes, so the host can write it somewhere
     * that outlives the process. The registry is the decision point and holds
     * the live answer; persistence is the host's business, because only it
     * knows where its settings live.
     */
    onDecisionsChanged?: (decisions: OriginDecisions) => void;
}

export interface OriginDecisions {
    allowed: string[];
    denied: string[];
}

/** Split a comma-separated env value into normalised origins. */
const parseOriginList = (raw: string | undefined): string[] =>
    (raw ?? '')
        .split(',')
        .map((entry) => normalizeOrigin(entry))
        .filter((entry): entry is string => !!entry);

/**
 * Origins compare exactly, so they have to be written the same way on both
 * sides: lower-cased, no trailing slash. A browser sends `https://cms.test`,
 * and an allowlist entry of `https://cms.test/` would never match it.
 */
export function normalizeOrigin(origin: string | undefined | null): string | null {
    const trimmed = origin?.trim().toLowerCase().replace(/\/+$/, '');
    return trimmed ? trimmed : null;
}

/**
 * Which browser origins may reach this local instance.
 *
 * The API binds to the loopback interface of someone's laptop, so the only
 * remote callers it ever has are web apps a browser is already running. CORS is
 * therefore the whole of the perimeter for those callers, and an open `origin:
 * true` would let any page a user happens to have open drive their encoder.
 */
@Injectable()
export class OriginRegistry {
    private readonly logger = new Logger(OriginRegistry.name);
    private readonly approved = new Set<string>();
    private readonly approver?: (origin: string) => Promise<boolean>;

    /**
     * One approval in flight per origin. A CMS page opening an SSE stream and
     * firing a POST at the same moment produces two preflights within a few
     * milliseconds; without this the user is shown two dialogs for one decision.
     */
    private readonly pending = new Map<string, Promise<boolean>>();

    /**
     * Origins the user said no to. Held here rather than by the host because
     * this class is the decision point: a denial the host checked separately
     * was a second place for the answer to live, and revoking one from the
     * settings screen would have had to reach both.
     */
    private readonly denied = new Set<string>();

    private readonly onDecisionsChanged?: (decisions: OriginDecisions) => void;

    constructor(@Inject(ORIGIN_POLICY) policy: OriginPolicy) {
        for (const origin of policy.allowedOrigins ?? []) {
            const normalized = normalizeOrigin(origin);
            if (normalized) this.approved.add(normalized);
        }
        for (const origin of policy.deniedOrigins ?? []) {
            const normalized = normalizeOrigin(origin);
            if (normalized) this.denied.add(normalized);
        }
        this.approver = policy.originApprover;
        this.onDecisionsChanged = policy.onDecisionsChanged;
    }

    /** Remember an origin as trusted for the life of this process. */
    approve(origin: string): void {
        const normalized = normalizeOrigin(origin);
        if (!normalized) return;
        this.approved.add(normalized);
        this.denied.delete(normalized);
        this.publish();
    }

    /** Every origin trusted right now — the static list plus anything granted since. */
    list(): string[] {
        return [...this.approved];
    }

    /** Every decision this instance is holding, for the settings screen. */
    decisions(): OriginDecisions {
        return { allowed: [...this.approved], denied: [...this.denied] };
    }

    /**
     * Forget a decision, whichever way it went.
     *
     * Revoking an allow shuts a site out; revoking a deny lets it ask again.
     * The second is the one that matters: clicking "Block" on your own CMS
     * otherwise locked you out of your own encoder with no route back inside
     * the product, only a settings file to edit by hand.
     *
     * Takes effect at once, because this registry is what the CORS layer asks
     * on every request — there is no cached copy anywhere to go stale.
     */
    revoke(origin: string): boolean {
        const normalized = normalizeOrigin(origin);
        if (!normalized) return false;

        const removed =
            this.approved.delete(normalized) || this.denied.delete(normalized);
        if (removed) {
            this.logger.log(`Origin decision revoked: ${normalized}`);
            this.publish();
        }
        return removed;
    }

    private publish(): void {
        this.onDecisionsChanged?.(this.decisions());
    }

    /**
     * Synchronous when the answer is already known, which is every request after
     * the first from a given origin. Only a genuinely unknown origin pays for a
     * round-trip to the approver.
     */
    isAllowed(origin: string): Promise<boolean> | boolean {
        const normalized = normalizeOrigin(origin);
        if (!normalized) return false;
        if (this.approved.has(normalized)) return true;
        // Answered already, and the answer was no. Asking again on every
        // request would let a site that keeps trying wear the user down.
        if (this.denied.has(normalized)) return false;
        if (!this.approver) return false;

        const inFlight = this.pending.get(normalized);
        if (inFlight) return inFlight;

        const decision = this.approver(normalized)
            .then((granted) => {
                if (granted) {
                    this.approved.add(normalized);
                    this.logger.log(`Origin approved: ${normalized}`);
                } else {
                    this.denied.add(normalized);
                    this.logger.warn(`Origin refused: ${normalized}`);
                }
                this.publish();
                return granted;
            })
            .catch((err: Error) => {
                // A dialog that failed to open is not consent.
                this.logger.warn(
                    `Origin approval failed for ${normalized}: ${err.message}`,
                );
                return false;
            })
            .finally(() => {
                this.pending.delete(normalized);
            });

        this.pending.set(normalized, decision);
        return decision;
    }
}

/**
 * Builds the provider for {@link ORIGIN_POLICY}. With no argument the allowlist
 * is read from `CMS_ALLOWED_ORIGINS` at module-init time (so `dotenv` has
 * already run) and no approver is installed; pass a policy to override both.
 */
export const createOriginPolicyProvider = (policy?: OriginPolicy): Provider => ({
    provide: ORIGIN_POLICY,
    useFactory: (): OriginPolicy =>
        policy ?? { allowedOrigins: parseOriginList(process.env.CMS_ALLOWED_ORIGINS) },
});
