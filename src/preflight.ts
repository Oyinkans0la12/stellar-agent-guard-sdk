/**
 * The pre-flight interceptor: ask the guard whether an action is permitted
 * *before* anything is signed for broadcast.
 *
 * This is the surface an agent framework integrates with. It answers one
 * question — "may this call proceed?" — and it answers it the same way the chain
 * would, because it runs the same enforcement: the guarded account's real
 * `__check_auth` against live ledger state, in a simulation that cannot mutate
 * anything. A refusal therefore costs nothing and cannot be bypassed by an agent
 * that ignores the answer, since the on-chain check still stands behind it.
 *
 * Three distinct answers, kept distinct on purpose:
 *
 *  - `admissible` — the guard approved. `estimatedResourceFee` is the network's
 *    own price for the call, taken from the same simulation.
 *  - `blocked` — the guard refused, with the contract's own reason. This is the
 *    guardrail working, and the reason is safe to show an operator.
 *  - `undetermined` — the enforcement run failed for a reason that is not a
 *    policy decision (a contract trap, a missing trustline, an unsupported
 *    credential type). **Treated as not-allowed**, because a guardrail must fail
 *    closed, but reported separately so an adapter never claims the guard
 *    refused something it never ruled on.
 *
 * A refused call never has a transaction hash. That is not a gap in the
 * evidence: the block happens before broadcast, which is what makes it free.
 */
import { Keypair, StrKey, rpc, xdr } from "@stellar/stellar-sdk";
import { concatBytes, sha256Hex, utf8Bytes } from "./hash.ts";
import {
  GuardError,
  GuardUndeterminedError,
  InvalidInputError,
  RateLimitedError,
  SimulationError,
} from "./errors.ts";
import { Semaphore } from "./semaphore.ts";
import { enforceCall, RpcTimeoutError, timeoutOutcome, withRpcAbort } from "./invoke.ts";
import {
  DEFAULT_RPC_TIMEOUT_MS,
} from "./invoke.ts";
import {
  resourceBreakdownFromSimulation,
  type CostProvenance,
  type ResourceBreakdown,
} from "./cost.ts";
import {
  extractTransferAmount,
  readPersistentEntry,
  type ContractAddress,
  type ReadonlyPolicyConfig,
} from "./policy.ts";
import { GuardBlockedError, explainReason } from "./reasons.ts";
import type { EnforcementOutcome, InvokeStepEvent } from "./invoke.ts";
import { guardEventsFromDiagnostics, type GuardEvent } from "./telemetry.ts";
import { resolveLogger, type GuardLogger, type GuardLoggerInput } from "./logger.ts";
import { parseSimulationResourceFee, toAgentSigner } from "./tx.ts";
import type { AgentSigner, ContractCall } from "./tx.ts";
import { systemClock, type Clock } from "./clock.ts";
import { withResolvedServer, type WithRpcTransport } from "./transport.ts";

/**
 * Re-exported from `errors.ts` for the existing import path.
 */
export { GuardUndeterminedError, InvalidInputError };

/**
 * Validate a ContractCall's input shape before RPC dispatch.
 * Throws InvalidInputError synchronously if any validation rule fails.
 */
export function validateContractCall(call: ContractCall): void {
  if (!call || typeof call !== "object") {
    throw new InvalidInputError("call", "required", "call must be an object");
  }

  // 1. Contract format check
  if (typeof call.contract !== "string" || call.contract.trim() === "") {
    throw new InvalidInputError("contract", "required", "contract ID is required and must be non-empty");
  }
  if (!StrKey.isValidContract(call.contract)) {
    throw new InvalidInputError(
      "contract",
      "invalid_format",
      "contract ID must be a valid C... StrKey contract address",
    );
  }

  // 2. Method presence and shape check
  if (typeof call.fn !== "string" || call.fn.trim() === "") {
    throw new InvalidInputError("fn", "required", "method name is required and must be non-empty");
  }
  if (call.fn.length > 32 || !/^[a-zA-Z0-9_]+$/.test(call.fn)) {
    throw new InvalidInputError(
      "fn",
      "symbol_shape",
      "method name must be a symbol-shaped string of 1-32 alphanumeric or underscore characters",
    );
  }

  // 3. Args array check
  if (!Array.isArray(call.args)) {
    throw new InvalidInputError("args", "array", "args must be an array of xdr.ScVal");
  }
  for (let i = 0; i < call.args.length; i++) {
    const arg = call.args[i] as unknown;
    if (!(arg instanceof xdr.ScVal)) {
      if (
        (call.fn === "transfer" && i === 2) ||
        (call.fn === "transfer_from" && i === 3)
      ) {
        throw new InvalidInputError(
          "amount",
          "i128_type",
          `amount at argument index ${i} must be an i128 ScVal (got ${typeof arg})`,
        );
      }
      throw new InvalidInputError(
        "args",
        "typed_scval",
        `argument at index ${i} must be an xdr.ScVal instance`,
      );
    }
  }

  // 4. Amount type check for known token operations
  if (call.fn === "transfer") {
    if (call.args.length < 3) {
      throw new InvalidInputError(
        "args",
        "missing_argument",
        "transfer expects at least 3 arguments: [from, to, amount]",
      );
    }
    const amountVal = call.args[2];
    if (!amountVal || amountVal.type !== "scvI128") {
      throw new InvalidInputError(
        "amount",
        "i128_type",
        `transfer amount must be an i128 ScVal (received type: ${amountVal?.type ?? "missing"})`,
      );
    }
  } else if (call.fn === "transfer_from") {
    if (call.args.length < 4) {
      throw new InvalidInputError(
        "args",
        "missing_argument",
        "transfer_from expects at least 4 arguments: [spender, from, to, amount]",
      );
    }
    const amountVal = call.args[3];
    if (!amountVal || amountVal.type !== "scvI128") {
      throw new InvalidInputError(
        "amount",
        "i128_type",
        `transfer_from amount must be an i128 ScVal (received type: ${amountVal?.type ?? "missing"})`,
      );
    }
  }
}

/**
 * Thrown when enforcement could not reach a decision.
 *
 * @deprecated Use `GuardUndeterminedError`. Kept as an alias for backward compatibility.
 */
export const PreFlightUndeterminedError = GuardUndeterminedError;
export type PreFlightUndeterminedError = GuardUndeterminedError;

/**
 * Provenance present only on a verdict served from the optional verdict cache.
 *
 * Fields are absent on a fresh simulation, so an existing consumer sees exactly
 * the shape it saw before the fields existed. They are also never part of the
 * cache key and never participate in equality: a hit and a freshly computed
 * verdict describe the same decision.
 */
export interface PreFlightCacheProvenance {
  /** True when the verdict was reused from the cache instead of re-simulated. */
  cached?: boolean;
  /** Ledger the cached verdict was computed against. */
  observedLedger?: number;
  /** Age of the cached verdict, in milliseconds, when it was returned. */
  ageMs?: number;
}

export type PreFlightDecision =
  | ({
      allowed: true;
      kind: "admissible";
      /** The network's own resource fee estimate for this call, in stroops. */
      estimatedResourceFee: bigint;
      /** Number of ledger keys the call is priced to touch. */
      footprintKeys: number;
      /** Resource limits and footprint counts from the same simulation. */
      resourceBreakdown?: ResourceBreakdown;
      /**
       * Ledger snapshot the simulation priced against, read from that same
       * simulation response. Informational only: it identifies the state the
       * quote describes, not a guarantee that submission will land there.
       * Omitted when the RPC response did not establish a usable ledger.
       */
      provenance?: CostProvenance;
    } & PreFlightCacheProvenance)
  | ({
      allowed: false;
      kind: "blocked";
      /** The contract's reason symbol, e.g. `per_tx_cap_exceeded`. */
      reason: string;
      /** One-line operator-facing meaning of `reason`. */
      explanation: string;
      detail: string;
      diagnosticEvents: unknown[];
    } & PreFlightCacheProvenance)
  | ({
      allowed: false;
      kind: "undetermined";
      detail: string;
      /** Machine-readable cause; use `instanceof` instead of matching `detail`. */
      error?: GuardError;
      /**
       * Coarse cause, set only when the failure has an operational remedy a
       * caller can branch on: `"rate_limited"` means the RPC kept answering
       * HTTP 429 (see `maxConcurrentSimulations`). Absent otherwise.
       */
      cause?: PreFlightUndeterminedCause;
    } & PreFlightCacheProvenance);

/** Causes an `undetermined` pre-flight verdict can carry (additive). */
export type PreFlightUndeterminedCause = "rate_limited";

/**
 * Read the ledger marker out of the simulation that produced the quote.
 *
 * This deliberately reads the successful enforced simulation's own
 * `latestLedger` instead of issuing `getLatestLedger()` again: a second read
 * can land on a newer ledger and would then describe state the simulation never
 * saw. The value is informational, and an absent or malformed marker is omitted
 * rather than replaced with a fabricated sequence number.
 */
function provenanceFromSimulation(simulation: unknown): CostProvenance | undefined {
  if (typeof simulation !== "object" || simulation === null) return undefined;
  const ledger = (simulation as { latestLedger?: unknown }).latestLedger;
  if (typeof ledger !== "number" || !Number.isSafeInteger(ledger) || ledger < 0) {
    return undefined;
  }
  return { ledger };
}

/**
 * Options for a batched pre-flight check.
 *
 * Both fields exist so a caller can run the batch check against values it
 * already knows, without an extra ledger read. Omit them and the interceptor
 * fetches the live policy and committed window spend from the guard's storage.
 */
export interface CheckBatchOptions {
  /**
   * Policy configuration to enforce against during batch staging.
   * If omitted, the interceptor attempts to fetch it from the guard's ledger storage.
   */
  policy?: ReadonlyPolicyConfig | null;

  /**
   * Initial committed amount already spent in the current rolling window.
   * If omitted, attempts to fetch it from the guard's `Window` ledger entry (defaults to 0n).
   */
  initialWindowSpent?: bigint;

  /**
   * Optional per-call observability, forwarded to each call's `check()`:
   * one event per enforcement-stage attempt, in call order.
   */
  onStep?: (step: InvokeStepEvent) => void;

  /**
   * Caller-owned cancellation for the whole batch. Once it fires, no further
   * call is started; every unfinished call is reported as a fail-closed
   * `undetermined` verdict carrying a typed `RpcTimeoutError`.
   */
  signal?: AbortSignal | undefined;

  /**
   * Per-call timeout, forwarded to each `check()`. Independent of
   * `deadlineMs`: a fired per-call timeout leaves the rest of the batch free to
   * continue, while a spent batch deadline stops it.
   */
  timeoutMs?: number | undefined;

  /**
   * Overall time budget for the whole batch, in milliseconds, measured from
   * the start of `checkBatch()` on the interceptor's injected clock.
   *
   * Once spent, no further call is started and the remaining verdicts are
   * fail-closed `undetermined` results carrying an `RpcTimeoutError` with
   * `deadline: true`. The budget also caps each individual check's timeout, so
   * a single long RPC cannot overrun it. Omit for the per-call default.
   */
  deadlineMs?: number | undefined;
}

/**
 * Options for `simulateForDiagnostics()`.
 *
 * `signal` and `timeoutMs` bound the RPC calls exactly as they do for
 * `check()`. `includeRaw` opts into retaining the undecoded source event on
 * each decoded event's `raw` field; it defaults to `false`, so diagnostics are
 * redacted of host payloads unless the caller asks for them.
 */
export interface SimulationDiagnosticsOptions {
  onStep?: (step: InvokeStepEvent) => void;
  signal?: AbortSignal | undefined;
  timeoutMs?: number | undefined;
  includeRaw?: boolean | undefined;
}

/**
 * The non-authoritative result of `simulateForDiagnostics()`.
 *
 * This is deliberately **not** a verdict: it has no `allowed`, `admissible`,
 * `blocked` or `undetermined` field, and `authoritative` is the literal
 * `false`. It reports what the network's simulation said, so a caller can
 * inspect an `undetermined` outcome without pretending the guard decided
 * anything. Nothing is signed for submission and nothing is broadcast.
 */
export interface SimulationDiagnostics {
  /** Always `false`: this result never answers the enforcement question. */
  readonly authoritative: false;
  /** True when both the probe and the enforced simulation ran successfully. */
  readonly ok: boolean;
  /** Human-readable failure text, or `null` when the simulations succeeded. */
  readonly detail: string | null;
  /** Resource usage from the enforced simulation, when it succeeded. */
  readonly resources: ResourceBreakdown | null;
  /** Simulated resource fee in stroops, when it parsed successfully. */
  readonly resourceFeeStroops: bigint | null;
  /** Decoded guard events; raw payloads only when `includeRaw` was set. */
  readonly events: GuardEvent[];
  /** The first decoded `event_auth_checked` decision, if there was one. */
  readonly guardEvent: GuardEvent | null;
  /** The typed failure, when the simulations could not complete. */
  readonly error: GuardError | null;
}

/**
 * Where the committed window spend used for batch staging came from.
 *
 * The distinction matters: an explicit `initialWindowSpent` (including `0n`)
 * is a caller-provided snapshot and is trusted, while a failed live read means
 * the SDK does not know the committed spend. A missing `Window` ledger entry is
 * a definitive "nothing committed yet", not a failed read.
 */
export type BatchStagingSource = "provided" | "ledger" | "absent" | "unavailable";

/** The staging snapshot a batch verdict was evaluated against. */
export interface PreFlightBatchStaging {
  /**
   * Committed window spend used for staging, or `null` when a required live
   * read failed. An explicitly supplied `0n` is reported as `0n` with source
   * `"provided"` — never confused with an unavailable read.
   */
  windowSpent: bigint | null;
  /** Where `windowSpent` came from. */
  source: BatchStagingSource;
  /**
   * True when a positive SAC transfer needed state that could not be read, so
   * the batch could not be staged to a definite verdict.
   */
  unavailable: boolean;
}

export interface PreFlightBatchDecision {
  /**
   * Overall batch verdict: true only if every call in the batch is admissible.
   * Mirrors the contract's all-or-nothing auth batch semantics.
   */
  admissible: boolean;

  /**
   * Alias for `admissible`.
   */
  overallAdmissible: boolean;

  /**
   * Overall batch classification. `undetermined` means the batch cannot be
   * reported as admissible because required staging state was unavailable (or
   * an individual call was undetermined); `blocked` means at least one call was
   * definitely refused. Always set on a result returned by `checkBatch()`.
   */
  kind?: "admissible" | "blocked" | "undetermined";

  /** Human-readable explanation when `kind` is `undetermined`. */
  detail?: string;

  /**
   * Per-call decisions in the exact order of the input batch.
   */
  verdicts: PreFlightDecision[];

  /**
   * Alias for `verdicts`.
   */
  calls: PreFlightDecision[];

  /**
   * Total estimated resource fee in stroops across all calls in the batch
   * that were admissible.
   */
  totalEstimatedResourceFee: bigint;

  /**
   * The window snapshot used for staging. Omitted for an empty batch, which
   * performs no staging.
   */
  staging?: PreFlightBatchStaging;
}

/** A caller-supplied policy revision token used as part of the cache key. */
export type PolicyRevision = string | number | bigint | boolean | null | undefined;

/** Per-call bound shared by `warmCache()`'s checks. */
export interface WarmCacheOptions {
  /** Abort signal forwarded to every warmed `check()`. */
  signal?: AbortSignal | undefined;
  /** Per-RPC timeout forwarded to every warmed `check()`. */
  timeoutMs?: number | undefined;
}

/** What `warmCache()` did, which is an optimization report — not a verdict. */
export interface WarmCacheSummary {
  /** Calls passed to `warmCache()`. */
  attempted: number;
  /** Verdicts stored (or already served from) the cache; `0` when disabled. */
  cached: number;
  /** Blocked verdicts, reported rather than thrown. */
  blocked: number;
  /** Verdicts that could not be determined, reported rather than thrown. */
  undetermined: number;
  /** Wall-clock duration of the warming pass, in milliseconds. */
  durationMs: number;
}

/**
 * Per-call options for `check()`.
 *
 * `onStep` receives the enforcement pipeline's stage attempts (probe → sign →
 * simulate; `check()` never broadcasts), using the same `InvokeStepEvent`
 * shape and shared trace vocabulary as `invoke()`'s `onStep`. Entirely
 * optional — omitting it changes nothing about the check.
 *
 * `signal` and `timeoutMs` bound the RPC calls the check makes (the ledger
 * lookup and the probe/enforced simulations). An already-aborted signal
 * returns before any RPC call is made; a mid-flight abort or a fired timeout
 * returns the check's fail-closed `undetermined` verdict carrying a typed
 * `RpcTimeoutError` — the guard reached no decision, which is exactly what
 * `undetermined` means, so a bound can never produce an `admissible` verdict.
 * Both default to the pipeline's shared behaviour: no signal, and
 * `DEFAULT_RPC_TIMEOUT_MS` for the timeout.
 */
export interface PreFlightCheckOptions {
  onStep?: (step: InvokeStepEvent) => void;
  /**
   * Bypass the verdict cache for this call only: run a new simulation and never
   * reuse a cached verdict, and share no coalesced run either. The cache is
   * left untouched (nothing is read and nothing is stored), so later checks
   * behave exactly as they did before.
   *
   * Use it before a high-value transfer when the cached verdict's age or ledger
   * (`cached`/`observedLedger`/`ageMs`) is older than the caller is willing to
   * accept.
   */
  forceFresh?: boolean;
  /**
   * Caller-owned cancellation; aborts the RPC calls the check makes. A fired
   * signal yields an `undetermined` verdict, never a throw.
   */
  signal?: AbortSignal | undefined;
  /**
   * Bound on each RPC call, in milliseconds; `0` disables the timeout. A fired
   * timeout yields the same `undetermined` verdict as an abort.
   */
  timeoutMs?: number | undefined;
}

export interface PreFlightCacheOptions {
  /**
   * Maximum cache age in milliseconds. The effective value is capped at one
   * approximate ledger-close interval (5 seconds), so a cache hit can never
   * cross a ledger boundary.
   */
  ttlMs?: number;
  /** Ledger-based spelling of `ttlMs`; one ledger is approximately 5 seconds. */
  ttlLedgers?: number;
  /**
   * Optional policy revision, or a getter for it. Supplying this makes a policy
   * change invalidate the entry even if the wall-clock TTL has not elapsed.
   */
  policyRevision?: PolicyRevision | (() => PolicyRevision | Promise<PolicyRevision>);
  /**
   * Maximum number of verdicts this interceptor holds at once. Omit it for an
   * unbounded cache (the pre-#333 behaviour); set it to bound a high-volume
   * agent's memory without disabling caching entirely.
   *
   * When the cache is full, storing a new call fingerprint evicts the
   * **least-recently-used** entry: a cache hit counts as use, as does a fresh
   * store for a fingerprint already present. Eviction is deterministic (Map
   * insertion order, refreshed on every hit), so the same sequence of checks
   * always evicts the same entries.
   *
   * Eviction only ever *removes* entries. A lookup still requires the entry to
   * be present, from the current ledger, and inside its TTL, so evicting can
   * never resurrect an expired or cross-ledger verdict — the worst it can do is
   * force a fresh simulation for a fingerprint that was recently cached.
   *
   * Must be a positive integer. `invalidate()` clears the entries; the bound
   * applies again to whatever refills the cache afterwards.
   */
  maxEntries?: number;
}

/**
 * What `new PreFlightInterceptor()` accepts: `PreFlightConfig` with the shared
 * `{ server? | url? }` transport (issue #117) in place of a mandatory `server`.
 */
export type PreFlightConfigInput = WithRpcTransport<PreFlightConfig>;

export interface PreFlightConfig {
  server: rpc.Server;
  networkPassphrase: string;
  /** The guarded smart account whose policy is being enforced. */
  guard: ContractAddress;
  /**
   * The key registered as the account's agent, used to sign the auth entry: an
   * `AgentSigner` for any signing setup, or a plain Ed25519 `Keypair` for the
   * single-key default.
   */
  agent: AgentSigner | Keypair;
  /** Classic account that pays fees and supplies the sequence number. */
  source: Keypair;
  /** Authorizers for non-guard requirements (e.g. an admin on a policy call). */
  accountSigners?: Keypair[];
  /** Optional policy to use for batch staging (otherwise fetched from ledger). */
  policy?: ReadonlyPolicyConfig | null;
  /**
   * Opt-in short-lived cache. Omit this property to preserve uncached behavior.
   * A cached verdict can be staler than one admitted transfer.
   *
   * The cache's ledger lookup is one of the RPC calls the check makes, so it
   * carries the check's `signal`/`timeoutMs` bound like every other one: an
   * already-aborted signal issues no RPC at all, and a stalled lookup fails the
   * check closed with an `undetermined` verdict instead of hanging it.
   */
  cache?: PreFlightCacheOptions;
  /**
   * Optional log sink for this interceptor's decision points: each verdict, and
   * every cache hit, store and invalidation.
   *
   * Omitted — the default — the interceptor says nothing at all. A verdict is
   * still returned exactly as before; the logger changes only whether anyone is
   * told about it.
   */
  logger?: GuardLoggerInput | undefined;
  /**
   * Coalesce concurrent checks for the same call and config into one
   * discovery/enforcement run. Defaults to `true`; set `false` to force every
   * call to run its own simulation.
   *
   * Coalescing is per interceptor, so the call fingerprint plus this instance's
   * config identity is the whole key. Each waiter still applies its own
   * `signal`/`timeoutMs`, and a settled run — including an undetermined one — is
   * removed immediately rather than retained as a cache. Checks that supply
   * `onStep` are never coalesced, so each caller receives its own trace.
   */
  coalesceInFlight?: boolean;
  /**
   * Most simulations this interceptor keeps in flight at once (default
   * {@link DEFAULT_MAX_CONCURRENT_SIMULATIONS}). The rest queue first-in
   * first-out, and the queue wait counts toward each check's `signal` /
   * `timeoutMs`.
   *
   * An agent firing dozens of tool calls at once would otherwise open dozens of
   * simultaneous RPC simulations, trip the provider's rate limit and turn the
   * whole burst into `undetermined` verdicts. Raise it for a self-hosted RPC
   * with generous limits; it must be a positive integer.
   */
  maxConcurrentSimulations?: number;
  /**
   * Handling of an HTTP 429 from the RPC. A rate-limited simulation waits once
   * (the server's `Retry-After` when sent, else `backoffMs`, never more than
   * `maxBackoffMs`) and is retried once; if it is limited again the verdict is
   * `undetermined` with `cause: "rate_limited"`. Bounded by construction.
   */
  rateLimit?: {
    /** Wait when the 429 carries no `Retry-After`. Default 500. */
    backoffMs?: number;
    /** Upper bound on any wait, including a long `Retry-After`. Default 5000. */
    maxBackoffMs?: number;
  };
  /**
   * Observability-only callback, invoked exactly once for every verdict
   * `check()` returns — including a cache hit, a coalesced result and a
   * fail-closed timeout verdict.
   *
   * It receives the final decision's kind, the contract reason (blocked only),
   * whether the verdict came from the cache, how long it took, the ledger when
   * known, and the call's function and contract. Arguments are never included.
   *
   * The hook cannot change a verdict: a throw (or a rejected promise from an
   * async hook) is caught and logged, and the caller still receives the
   * original verdict and fee data. It is not invoked when input validation
   * throws, because no verdict was produced.
   */
  onVerdict?: (event: PreFlightVerdictEvent) => void;
  /**
   * Inject a custom clock for time-dependent operations (cache TTL, batch
   * deadlines, etc.). Defaults to the system clock; use a FakeClock in tests
   * for deterministic timing.
   */
  clock?: Clock;
}

/**
 * The payload of the `onVerdict` observer hook.
 *
 * Deliberately a summary, not a verdict copy: it is safe to ship to metrics and
 * logs, and it never carries call arguments, diagnostic events or XDR.
 */
export interface PreFlightVerdictEvent {
  /** The verdict that was returned. */
  kind: PreFlightDecision["kind"];
  /** The contract's refusal reason; present only for `blocked`. */
  reason?: string;
  /** True when the verdict was served from the cache. */
  cached: boolean;
  /** Wall-clock time spent producing the verdict, in milliseconds. */
  durationMs: number;
  /** Ledger the verdict was evaluated against, when known. */
  ledger?: number;
  /** The call's identity: function and contract only, never its arguments. */
  call: { fn: string; contract: string };
}

/** Default for `maxConcurrentSimulations`. */
export const DEFAULT_MAX_CONCURRENT_SIMULATIONS = 4;
const DEFAULT_RATE_LIMIT_BACKOFF_MS = 500;
const DEFAULT_RATE_LIMIT_MAX_BACKOFF_MS = 5_000;

/**
 * Read an HTTP 429 out of an error chain (axios-style `response.status`, or a
 * bare `status` / `statusCode`), with the server's `Retry-After` in ms when it
 * sent a delay in seconds or an HTTP date.
 */
function rateLimitOf(error: unknown, now: number): { retryAfterMs: number | null } | null {
  let current: unknown = error;
  for (let depth = 0; depth < 6 && typeof current === "object" && current !== null; depth++) {
    const e = current as {
      status?: unknown;
      statusCode?: unknown;
      response?: { status?: unknown; headers?: unknown };
      cause?: unknown;
    };
    if (e.response?.status === 429 || e.status === 429 || e.statusCode === 429) {
      const headers = e.response?.headers as
        | { get?: (name: string) => unknown; [k: string]: unknown }
        | undefined;
      const raw =
        typeof headers?.get === "function" ? headers.get("retry-after") : headers?.["retry-after"];
      let retryAfterMs: number | null = null;
      if (typeof raw === "string" || typeof raw === "number") {
        const seconds = Number(raw);
        if (Number.isFinite(seconds) && seconds >= 0) retryAfterMs = Math.round(seconds * 1000);
        else {
          const at = Date.parse(String(raw));
          if (Number.isFinite(at)) retryAfterMs = Math.max(0, at - now);
        }
      }
      return { retryAfterMs };
    }
    current = e.cause;
  }
  return null;
}

/** Alias used by the README's constructor terminology. */
export type PreFlightInterceptorOptions = PreFlightConfig;

const LEDGER_CLOSE_MS = 5_000;
const MAX_CACHE_TTL_MS = LEDGER_CLOSE_MS;

interface CacheEntry {
  decision: PreFlightDecision;
  ledger: number;
  storedAt: number;
  expiresAt: number;
}

interface CacheContext {
  key: string;
  ledger: number;
  expiresAt: number;
}

/**
 * The outcome of a cache-context lookup.
 *
 * - `context` — the cache could be consulted: the ledger marker is known and
 *   the entry key is derived from it.
 * - `unavailable` — the cache could *not* be consulted (an unreadable policy
 *   revision, or a ledger read that failed for a reason that is not the
 *   caller's bound). That is not a security decision: the check falls back to
 *   the uncached enforcement path, which runs under the same bound.
 * - `bounded` — the caller's own signal or timeout fired during the lookup.
 *   There is no budget left to run the uncached path within, so the check
 *   fails closed with an `undetermined` verdict.
 */
type CacheLookup =
  | { kind: "context"; context: CacheContext }
  | { kind: "unavailable" }
  | { kind: "bounded"; error: RpcTimeoutError };

/**
 * The fail-closed verdict for an unexpected throw escaping `check()`.
 *
 * The original value becomes `cause` whether or not it is an `Error`, so a
 * string or plain-object rejection is preserved rather than stringified away.
 * The verdict is always `undetermined`: a failure the guard did not rule on
 * can never be reported as `admissible`.
 */
function undeterminedFromThrow(cause: unknown): PreFlightDecision {
  const detail = cause instanceof Error ? cause.message : String(cause);
  const message = `pre-flight enforcement failed unexpectedly: ${detail}`;
  return {
    allowed: false,
    kind: "undetermined",
    detail: message,
    error:
      cause instanceof GuardUndeterminedError
        ? cause
        : new GuardUndeterminedError(message, { stage: "preflight", cause, detail }),
  };
}

/** The fail-closed verdict for a caller bound that fired. */
function timeoutDecision(error: RpcTimeoutError): PreFlightDecision {
  const outcome = timeoutOutcome(error);
  return {
    allowed: false,
    kind: "undetermined",
    detail: outcome.detail,
    error: outcome.error,
  };
}

function policyRevisionToken(revision: PolicyRevision): string {
  if (revision === undefined) return "unknown";
  if (revision === null) return "null";
  return `${typeof revision}:${String(revision)}`;
}

function hashPart(parts: Uint8Array[], value: string | Uint8Array): void {
  const bytes = typeof value === "string" ? utf8Bytes(value) : value;
  const length = new Uint8Array(4);
  new DataView(length.buffer).setUint32(0, bytes.length, false);
  parts.push(length, bytes);
}

function callFingerprint(call: ContractCall): string {
  const parts: Uint8Array[] = [];
  hashPart(parts, call.contract);
  hashPart(parts, call.fn);
  for (const arg of call.args) hashPart(parts, arg.toXDR());
  return sha256Hex(concatBytes(parts));
}

function configFingerprint(config: PreFlightConfig): string {
  const parts: Uint8Array[] = [];
  hashPart(parts, config.networkPassphrase);
  hashPart(parts, config.guard);
  hashPart(parts, config.source.publicKey());
  hashPart(parts, toAgentSigner(config.agent).publicKey);
  for (const signer of (config.accountSigners ?? []).map((keypair) => keypair.publicKey()).sort()) {
    hashPart(parts, signer);
  }
  return sha256Hex(concatBytes(parts));
}

export class PreFlightInterceptor {
  private readonly config: PreFlightConfig;
  private readonly cacheOptions: PreFlightCacheOptions | undefined;
  private readonly cache = new Map<string, CacheEntry>();
  private readonly inFlight = new Map<string, Promise<PreFlightDecision>>();
  private readonly namespace: string;
  private readonly coalesceInFlight: boolean;
  private readonly simulations: Semaphore;
  private readonly rateLimitBackoffMs: number;
  private readonly rateLimitMaxBackoffMs: number;
  private readonly logger: GuardLogger;
  private readonly clock: Clock;
  private _hits = 0;
  private _misses = 0;
  private _invalidations = 0;
  private _stores = 0;

  constructor(input: PreFlightConfigInput) {
    // Shared transport (issue #117): exactly one of `server` or `url`.
    const config = withResolvedServer<PreFlightConfig>(input);
    this.config = config;
    this.cacheOptions = config.cache;
    this.clock = config.clock ?? systemClock;
    this.coalesceInFlight = config.coalesceInFlight !== false;
    this.validateCacheOptions();
    const maxConcurrent = config.maxConcurrentSimulations ?? DEFAULT_MAX_CONCURRENT_SIMULATIONS;
    if (!Number.isInteger(maxConcurrent) || maxConcurrent <= 0) {
      throw new TypeError("preflight maxConcurrentSimulations must be a positive integer");
    }
    this.simulations = new Semaphore(maxConcurrent);
    this.rateLimitBackoffMs = config.rateLimit?.backoffMs ?? DEFAULT_RATE_LIMIT_BACKOFF_MS;
    this.rateLimitMaxBackoffMs = config.rateLimit?.maxBackoffMs ?? DEFAULT_RATE_LIMIT_MAX_BACKOFF_MS;
    for (const [name, value] of [
      ["rateLimit.backoffMs", this.rateLimitBackoffMs],
      ["rateLimit.maxBackoffMs", this.rateLimitMaxBackoffMs],
    ] as const) {
      if (!Number.isFinite(value) || value < 0) {
        throw new TypeError(`preflight ${name} must be a non-negative finite number`);
      }
    }
    this.namespace = this.cacheOptions ? configFingerprint(config) : "";
    this.logger = resolveLogger(config.logger);
  }

  private validateCacheOptions(): void {
    if (!this.cacheOptions) return;
    const { ttlMs, ttlLedgers, maxEntries } = this.cacheOptions;
    if (ttlMs === undefined && ttlLedgers === undefined) {
      throw new TypeError("preflight cache requires ttlMs or ttlLedgers");
    }
    if (ttlMs !== undefined && (!Number.isFinite(ttlMs) || ttlMs <= 0)) {
      throw new TypeError("preflight cache ttlMs must be a positive finite number");
    }
    if (ttlLedgers !== undefined && (!Number.isFinite(ttlLedgers) || ttlLedgers <= 0)) {
      throw new TypeError("preflight cache ttlLedgers must be a positive finite number");
    }
    if (maxEntries !== undefined && (!Number.isInteger(maxEntries) || maxEntries <= 0)) {
      throw new TypeError("preflight cache maxEntries must be a positive integer");
    }
  }

  /**
   * Record a cache hit as the most recent use. Map iteration is insertion
   * order, so re-inserting is what makes the head of the map the least
   * recently used entry for `storeCacheEntry` to evict next.
   *
   * Only the bounded mode needs this bookkeeping; an unbounded cache never
   * evicts, so it keeps the cheaper read-only hit path.
   */
  private touch(key: string, entry: CacheEntry): void {
    if (this.cacheOptions?.maxEntries === undefined) return;
    this.cache.delete(key);
    this.cache.set(key, entry);
  }

  /**
   * Store a verdict, keeping the cache at or below `maxEntries`.
   *
   * Expired and cross-ledger entries are already purged by `cacheContext`
   * before this runs, but eviction is still an unconditional removal: it never
   * selects an entry to *return*, only one to drop, so a bounded cache cannot
   * revive a verdict the freshness checks would reject.
   */
  private storeCacheEntry(key: string, entry: CacheEntry): void {
    const maxEntries = this.cacheOptions?.maxEntries;
    if (maxEntries !== undefined) {
      // An overwrite is not a new fingerprint: drop the previous occurrence
      // first so it cannot count against capacity or be evicted as "old".
      this.cache.delete(key);
      let evicted = 0;
      while (this.cache.size >= maxEntries) {
        const oldest = this.cache.keys().next();
        if (oldest.done) break;
        this.cache.delete(oldest.value);
        evicted += 1;
      }
      if (evicted > 0) {
        this.logger.debug("pre-flight cache evicted least-recently-used verdicts", {
          evicted,
          maxEntries,
        });
      }
    }
    this.cache.set(key, entry);
    this._stores += 1;
  }

  private cacheTtlMs(): number {
    const { ttlMs, ttlLedgers } = this.cacheOptions ?? {};
    const requested = ttlMs ?? (ttlLedgers ?? 0) * LEDGER_CLOSE_MS;
    return Math.min(requested, MAX_CACHE_TTL_MS);
  }

  /**
   * Resolve the cache context for `call`: the ledger marker the cached verdict
   * must belong to, and the key it is stored under.
   *
   * The ledger read is one of the RPC calls the check makes, so it carries the
   * same abort/timeout semantics as the enforcement pipeline: an already-aborted
   * signal issues no RPC at all, and a stalled read is bounded by the caller's
   * `timeoutMs` instead of leaving the check pending indefinitely.
   *
   * A failed read is not a security decision. Without a trustworthy ledger
   * marker no cached verdict may be reused, so the lookup reports
   * `unavailable` and the caller falls back to the uncached enforcement path.
   * That fallback is only allowed while it remains inside the caller's bound:
   * a lookup whose own bound fired reports `bounded`, and the check fails
   * closed rather than spending a budget the caller never granted.
   */
  private async cacheContext(
    call: ContractCall,
    bound: { signal?: AbortSignal | undefined; timeoutMs?: number | undefined },
  ): Promise<CacheLookup> {
    if (!this.cacheOptions) return { kind: "unavailable" };

    let revision: PolicyRevision;
    try {
      if (typeof this.cacheOptions.policyRevision === "function") {
        revision = await this.cacheOptions.policyRevision();
        if (revision === undefined) return { kind: "unavailable" };
      } else {
        revision = this.cacheOptions.policyRevision;
      }
    } catch {
      // A revision read failure must not turn a cache lookup into a security
      // decision. Fall through to the uncached path instead.
      return { kind: "unavailable" };
    }

    let ledger: number;
    try {
      const latest = await withRpcAbort(
        { stage: "pre-flight", signal: bound.signal, timeoutMs: bound.timeoutMs },
        () => this.config.server.getLatestLedger(),
      );
      ledger = latest.sequence;
    } catch (error) {
      if (error instanceof RpcTimeoutError) {
        // The caller's bound fired while the ledger read was in flight. The
        // uncached path would need a budget the caller has not granted, so the
        // check fails closed instead of running on.
        return { kind: "bounded", error };
      }
      // Without a trustworthy ledger marker, do not reuse a cached verdict.
      return { kind: "unavailable" };
    }

    const now = this.clock.now();
    for (const [key, entry] of this.cache) {
      if (entry.ledger !== ledger || entry.expiresAt <= now) this.cache.delete(key);
    }

    return {
      kind: "context",
      context: {
        key: `${this.namespace}:${callFingerprint(call)}:${policyRevisionToken(revision)}`,
        ledger,
        expiresAt: now + this.cacheTtlMs(),
      },
    };
  }

  /** Clear all cached verdicts, or only entries for `call` when provided. */
  invalidate(call?: ContractCall): void {
    if (!call) {
      const cleared = this.cache.size;
      this.cache.clear();
      this.logger.debug("pre-flight cache invalidated", { scope: "all", cleared });
      this._invalidations += cleared;
      return;
    }
    const prefix = `${this.namespace}:${callFingerprint(call)}:`;
    let cleared = 0;
    for (const key of this.cache.keys()) {
      if (key.startsWith(prefix)) {
        this.cache.delete(key);
        cleared += 1;
      }
    }
    this.logger.debug("pre-flight cache invalidated", { scope: "call", cleared });
    this._invalidations += cleared;
  }

  /**
   * Decide whether `call` may proceed. Never broadcasts, never mutates, never
   * throws for a refusal — a block is a normal, expected result.
   *
   * Accepts per-call `options` (e.g. `onStep` observability) without any
   * effect on the verdict itself; existing single-argument callers are
   * unaffected.
   *
   * With the cache enabled, the cache's ledger lookup is one of the RPC calls
   * the check makes, so it carries the same `signal`/`timeoutMs` bound as the
   * enforcement pipeline: an already-aborted signal issues no RPC at all, and a
   * stalled lookup returns the fail-closed `undetermined` verdict instead of
   * leaving the check pending forever.
   *
   * Concurrent checks for the same call and config share a single in-flight
   * discovery/enforcement run by default. The shared run is not bound by any
   * one caller's signal or timeout — one caller giving up must not cancel a
   * result another waiter is still entitled to — so each caller races the same
   * work against its own bound instead.
   */
  async check(call: ContractCall, options?: PreFlightCheckOptions): Promise<PreFlightDecision> {
    // Input validation throws before a verdict exists, so it never reaches the
    // observer: `onVerdict` reports decisions, not caller mistakes.
    validateContractCall(call);
    let startedAt: number | undefined;
    try {
      startedAt = this.clock.now();
      const result = await this.decide(call, options);
      this.emitVerdict(call, result.decision, startedAt, result.cached, result.ledger);
      return result.decision;
    } catch (cause) {
      // Every other throwable is a fail-closed verdict, not a rejection: an
      // unexpected failure (a custom `Clock`, an injected server, a mapper)
      // must never escape and be misclassified by an adapter.
      if (cause instanceof InvalidInputError) throw cause;
      const decision = undeterminedFromThrow(cause);
      // The observer needs the clock that just failed, so a broken clock must
      // not turn the fail-closed verdict back into a rejection.
      if (startedAt !== undefined) {
        this.emitVerdict(call, decision, startedAt, false, undefined);
      }
      return decision;
    }
  }

  /**
   * Run the probe and enforced simulation for diagnostics only.
   *
   * This exposes the same pipeline `check()` uses — same transport, auth entry,
   * signing and timeout handling — but returns no verdict. The result is
   * explicitly non-authoritative (`authoritative: false`), so an integrator can
   * inspect an `undetermined` case without mistaking the network's answer for a
   * policy decision. Nothing is signed for submission and nothing is broadcast,
   * and the result is never cached or coalesced.
   */
  async simulateForDiagnostics(
    call: ContractCall,
    options?: SimulationDiagnosticsOptions,
  ): Promise<SimulationDiagnostics> {
    validateContractCall(call);
    const abandoned = new AbortController();
    let outcome: EnforcementOutcome;
    try {
      outcome = await withRpcAbort(
        {
          stage: "pre-flight",
          signal: options?.signal,
          timeoutMs: options?.timeoutMs,
        },
        () => this.simulateLimited(call, options?.onStep, abandoned.signal),
      );
    } catch (error) {
      abandoned.abort();
      if (!(error instanceof RpcTimeoutError)) throw error;
      outcome = timeoutOutcome(error);
    }

    const rawDiagnostics = outcome.kind === "admissible" ? [] : outcome.diagnosticEvents;
    const events = guardEventsFromDiagnostics(rawDiagnostics, this.config.guard, {
      includeRaw: options?.includeRaw === true,
    });
    const guardEvent = events.find((event) => event.kind === "auth_checked") ?? null;

    if (outcome.kind !== "admissible") {
      return {
        authoritative: false,
        ok: false,
        detail: outcome.detail,
        resources: null,
        resourceFeeStroops: null,
        events,
        guardEvent,
        error: outcome.kind === "error" ? outcome.error : null,
      };
    }

    let resourceFeeStroops: bigint | null;
    try {
      resourceFeeStroops = parseSimulationResourceFee(outcome.simulation.minResourceFee, {
        stage: "preflight",
      });
    } catch {
      resourceFeeStroops = null;
    }
    return {
      authoritative: false,
      ok: true,
      detail: null,
      resources: resourceBreakdownFromSimulation(outcome.simulation) ?? null,
      resourceFeeStroops,
      events,
      guardEvent,
      error: null,
    };
  }

  /**
   * The decision path behind `check()`, returning the verdict together with its
   * cache provenance so `check()` can notify the observer exactly once.
   */
  private async decide(
    call: ContractCall,
    options?: PreFlightCheckOptions,
  ): Promise<{ decision: PreFlightDecision; cached: boolean; ledger: number | undefined }> {
    // `forceFresh` bypasses the cache entirely — no lookup, no store, and no
    // coalesced run — so the caller gets a new simulation and the cache is
    // left exactly as it was.
    if (options?.forceFresh) {
      const decision = await this.computeDecision(call, null, options.onStep, {
        signal: options.signal,
        timeoutMs: options.timeoutMs,
      });
      return { decision, cached: false, ledger: undefined };
    }

    // An already-aborted caller asks for no work at all, including the cache
    // lookup's ledger read. Answer before any RPC or in-flight registration.
    if (options?.signal?.aborted) {
      return {
        decision: timeoutDecision(new RpcTimeoutError({ stage: "pre-flight", aborted: true })),
        cached: false,
        ledger: undefined,
      };
    }

    const lookup = await this.cacheContext(call, {
      signal: options?.signal,
      timeoutMs: options?.timeoutMs,
    });
    if (lookup.kind === "bounded") {
      // The caller's bound fired while the cache's ledger read was in flight.
      // The check fails closed: a stalled RPC must never leave a guardrail
      // call pending indefinitely, and the uncached path would need a budget
      // the caller has not granted.
      return { decision: timeoutDecision(lookup.error), cached: false, ledger: undefined };
    }
    if (lookup.kind === "unavailable" && options?.signal?.aborted) {
      // The cache could not be consulted and the caller has already given up:
      // the uncached path is no longer within the caller's bound, so the check
      // fails closed instead of starting work nobody is waiting for.
      return {
        decision: timeoutDecision(new RpcTimeoutError({ stage: "pre-flight", aborted: true })),
        cached: false,
        ledger: undefined,
      };
    }
    const context = lookup.kind === "context" ? lookup.context : null;
    if (context) {
      const cached = this.cache.get(context.key);
      if (cached) {
        const now = this.clock.now();
        if (cached.ledger === context.ledger && cached.expiresAt > now) {
          this.touch(context.key, cached);
          // A hit is worth a line of its own: it is the one verdict the caller
          // gets without a simulation, so a host reading logs needs to be able
          // to tell a reused verdict from a fresh one.
          this.logger.debug("pre-flight verdict served from cache", {
            guard: this.config.guard,
            contract: call.contract,
            fn: call.fn,
            kind: cached.decision.kind,
            ledger: context.ledger,
          });
          this._hits++;
          // Provenance is added to the returned copy only: the stored verdict
          // stays timeless, so a later hit reports its own age rather than the
          // age of the first hit.
          return {
            decision: {
              ...cached.decision,
              cached: true,
              observedLedger: cached.ledger,
              ageMs: Math.max(0, now - cached.storedAt),
            } as PreFlightDecision,
            cached: true,
            ledger: context.ledger,
          };
        }
        this.cache.delete(context.key);
      }
      // If we have a context but didn't get a valid hit, it's a miss.
      this._misses++;
    }

    // An `onStep` observer owns its enforcement trace, so a check that supplies
    // one is not coalesced: sharing a run would either drop that observer's
    // events or interleave two observers over one pipeline.
    if (options?.onStep || !this.coalesceInFlight) {
      const decision = await this.computeDecision(call, context, options?.onStep, {
        signal: options?.signal,
        timeoutMs: options?.timeoutMs,
      });
      return { decision, cached: false, ledger: context?.ledger };
    }

    // The map is per interceptor, so the call fingerprint plus this instance's
    // config identity is the whole in-flight key.
    const key = context ? context.key : callFingerprint(call);
    let shared = this.inFlight.get(key);
    if (!shared) {
      // The shared run keeps the pipeline's default bound so a hung RPC cannot
      // pin the entry forever; callers that asked for a tighter bound race it
      // below, and never shorten it for anyone else.
      shared = this.computeDecision(call, context, undefined, {
        timeoutMs: DEFAULT_RPC_TIMEOUT_MS,
      });
      this.inFlight.set(key, shared);
      const settle = () => {
        if (this.inFlight.get(key) === shared) this.inFlight.delete(key);
      };
      // Remove on both success and failure. Coalescing is not a cache: no
      // outcome — admitted, refused or undetermined — survives the run.
      shared.then(settle, settle);
    }
    const decision = await this.awaitWithCallerBound(shared, options);
    return { decision, cached: false, ledger: context?.ledger };
  }

  /**
   * Notify the observability hook once, after the verdict is final.
   *
   * Observability must never influence enforcement: a throwing hook, or an
   * async hook that rejects, is caught and logged and the caller still receives
   * the original verdict and fee data.
   */
  private emitVerdict(
    call: ContractCall,
    decision: PreFlightDecision,
    startedAt: number,
    cached: boolean,
    ledger: number | undefined,
  ): void {
    const hook = this.config.onVerdict;
    if (!hook) return;
    let now = startedAt;
    try {
      now = this.clock.now();
    } catch {
      /* a broken clock cannot stop the verdict from being reported */
    }
    const event: PreFlightVerdictEvent = {
      kind: decision.kind,
      cached,
      durationMs: Math.max(0, now - startedAt),
      call: { fn: call.fn, contract: call.contract },
      ...(decision.kind === "blocked" ? { reason: decision.reason } : {}),
      ...(ledger !== undefined ? { ledger } : {}),
    };
    try {
      const returned = hook(event) as unknown;
      if (returned && typeof (returned as PromiseLike<unknown>).then === "function") {
        void Promise.resolve(returned).catch((error: unknown) => {
          this.logger.warn("pre-flight onVerdict observer rejected; verdict is unchanged", {
            guard: this.config.guard,
            error: error instanceof Error ? error.message : String(error),
          });
        });
      }
    } catch (error) {
      this.logger.warn("pre-flight onVerdict observer threw; verdict is unchanged", {
        guard: this.config.guard,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /** Race coalesced work against the waiting caller's own signal/timeout. */
  private async awaitWithCallerBound(
    work: Promise<PreFlightDecision>,
    options?: PreFlightCheckOptions,
  ): Promise<PreFlightDecision> {
    const { signal, timeoutMs } = options ?? {};
    if (!signal && timeoutMs === undefined) return work;
    try {
      return await withRpcAbort(
        { stage: "pre-flight", signal, timeoutMs: timeoutMs ?? 0 },
        () => work,
      );
    } catch (error) {
      if (!(error instanceof RpcTimeoutError)) throw error;
      return timeoutDecision(error);
    }
  }

  /**
   * Run one enforced simulation inside a concurrency slot, with one bounded
   * retry when the RPC answers HTTP 429.
   *
   * The slot is held across the 429 backoff on purpose: a rate-limited RPC is
   * asking every caller to slow down, so the pause throttles the whole queue.
   */
  private async simulateLimited(
    call: ContractCall,
    onStep: ((step: InvokeStepEvent) => void) | undefined,
    abandoned: AbortSignal,
  ): Promise<EnforcementOutcome> {
    const release = await this.simulations.acquire(abandoned);
    // Withdrawn while queued: the caller already got its verdict from its bound.
    if (release === null) return timeoutOutcome(new RpcTimeoutError({ stage: "pre-flight", aborted: true }));
    try {
      const run = async (): Promise<EnforcementOutcome | { limited: { retryAfterMs: number | null }; cause: unknown }> => {
        let outcome: EnforcementOutcome;
        try {
          outcome = await enforceCall({
            server: this.config.server,
            source: this.config.source,
            call,
            networkPassphrase: this.config.networkPassphrase,
            guardAuth: { guard: this.config.guard, agent: this.config.agent },
            ...(this.config.accountSigners ? { accountSigners: this.config.accountSigners } : {}),
            ...(onStep ? { onStep } : {}),
            ...(this.config.logger ? { logger: this.config.logger } : {}),
          });
        } catch (error) {
          const limited = rateLimitOf(error, this.clock.now());
          if (limited) return { limited, cause: error };
          throw error;
        }
        if (outcome.kind === "error") {
          const limited = rateLimitOf(outcome.error, this.clock.now());
          if (limited) return { limited, cause: outcome.error };
        }
        return outcome;
      };

      let result = await run();
      if (!("limited" in result)) return result;

      const wait = Math.min(
        result.limited.retryAfterMs ?? this.rateLimitBackoffMs,
        this.rateLimitMaxBackoffMs,
      );
      this.logger.warn("RPC rate-limited the simulation (429); backing off once", {
        guard: this.config.guard,
        waitMs: wait,
      });
      await this.clock.sleep(wait);
      if (abandoned.aborted) {
        return timeoutOutcome(new RpcTimeoutError({ stage: "pre-flight", aborted: true }));
      }
      result = await run();
      if (!("limited" in result)) return result;

      const error = new RateLimitedError({
        stage: "simulate",
        retryAfterMs: result.limited.retryAfterMs,
        attempts: 2,
        cause: result.cause,
      });
      return { kind: "error", detail: error.message, error, diagnosticEvents: [] };
    } finally {
      release();
    }
  }

  private async computeDecision(
    call: ContractCall,
    context: CacheContext | null,
    onStep: ((step: InvokeStepEvent) => void) | undefined,
    bound: { signal?: AbortSignal | undefined; timeoutMs?: number | undefined },
  ): Promise<PreFlightDecision> {
    // A bound that fired is a verdict, not a crash: the guard never reached a
    // decision, so the check returns its fail-closed `undetermined` arm (the
    // same arm any other unrunnable simulation takes) carrying the typed
    // `RpcTimeoutError`. `invoke()` reports the same error through its own
    // `error` outcome instead — a verdict question versus a pipeline question.
    let outcome: EnforcementOutcome;
    // Cancels a still-queued slot request when the caller's bound fires, so an
    // abandoned check never takes capacity later.
    const abandoned = new AbortController();
    try {
      outcome = await withRpcAbort(
        {
          stage: "pre-flight",
          signal: bound.signal,
          timeoutMs: bound.timeoutMs,
        },
        () => this.simulateLimited(call, onStep, abandoned.signal),
      );
    } catch (error) {
      abandoned.abort();
      if (!(error instanceof RpcTimeoutError)) throw error;
      outcome = timeoutOutcome(error);
    }
    const rateLimited =
      outcome.kind === "error" && outcome.error instanceof RateLimitedError;

    let decision: PreFlightDecision;
    if (outcome.kind === "error") {
      decision = {
        allowed: false,
        kind: "undetermined",
        detail: outcome.detail,
        error: outcome.error,
        ...(rateLimited ? { cause: "rate_limited" as const } : {}),
      };
    } else if (outcome.kind === "blocked") {
      decision = {
        allowed: false,
        kind: "blocked",
        reason: outcome.reason,
        explanation: explainReason(outcome.reason),
        detail: outcome.detail,
        diagnosticEvents: outcome.diagnosticEvents,
      };
    } else {
      const resourceBreakdown = resourceBreakdownFromSimulation(outcome.simulation);
      const data = outcome.simulation.transactionData as unknown as
        | { getReadOnly?: () => unknown[]; getReadWrite?: () => unknown[] }
        | undefined;
      const footprintKeys =
        (data?.getReadOnly?.().length ?? 0) + (data?.getReadWrite?.().length ?? 0);

      // Fail closed on an unpriceable simulation: a guardrail must never hand
      // back an admissible verdict carrying a fabricated or silently zero fee.
      let estimatedResourceFee: bigint;
      try {
        estimatedResourceFee = parseSimulationResourceFee(outcome.simulation.minResourceFee, {
          stage: "preflight",
        });
      } catch (cause) {
        decision = {
          allowed: false,
          kind: "undetermined",
          detail: `enforced simulation returned an invalid resource fee: ${
            cause instanceof Error ? cause.message : String(cause)
          }`,
          error:
            cause instanceof GuardError
              ? cause
              : new SimulationError("enforced simulation returned an invalid resource fee", {
                  stage: "preflight",
                  cause,
                }),
        };
        return decision;
      }
      const provenance = provenanceFromSimulation(outcome.simulation);
      decision = {
        allowed: true,
        kind: "admissible",
        estimatedResourceFee,
        footprintKeys,
        ...(resourceBreakdown ? { resourceBreakdown } : {}),
        ...(provenance ? { provenance } : {}),
      };
    }

    // An undetermined result is not a verdict and may be transient, so it is
    // deliberately not cached. Actual admissible/blocked results are.
    if (context && decision.kind !== "undetermined") {
      this.storeCacheEntry(context.key, {
        decision,
        ledger: context.ledger,
        storedAt: this.clock.now(),
        expiresAt: context.expiresAt,
      });
      this.logger.debug("pre-flight verdict cached", {
        kind: decision.kind,
        ledger: context.ledger,
      });
    }

    // The verdict itself, at the level its severity deserves: a refusal is the
    // guardrail working and is reported as information, a decision that could
    // not be reached is a degraded state and is reported as a warning.
    if (decision.kind === "blocked") {
      this.logger.info(`guard refused the call (${decision.reason})`, {
        guard: this.config.guard,
        contract: call.contract,
        fn: call.fn,
        reason: decision.reason,
      });
    } else if (decision.kind === "undetermined") {
      this.logger.warn(`pre-flight could not determine enforcement: ${decision.detail}`, {
        guard: this.config.guard,
        contract: call.contract,
        fn: call.fn,
      });
    } else {
      this.logger.debug("call admitted by the guard", {
        guard: this.config.guard,
        contract: call.contract,
        fn: call.fn,
        // A string, not the raw bigint: a JSON logger cannot serialise one.
        estimatedResourceFee: decision.estimatedResourceFee.toString(),
        footprintKeys: decision.footprintKeys,
      });
    }
    return decision;
  }

  /**
   * Decide whether an entire batch of calls may proceed with all-or-nothing semantics.
   *
   * Mirrors the contract's staged window evaluation:
   * 1. Evaluates each call in sequence.
   * 2. For SAC transfers, tracks the cumulative admitted amounts in memory ("simulated staging").
   * 3. If an individual call passes simulation in isolation but would push the cumulative
   *    staged window spend past `window_cap`, it is marked as `blocked` with reason
   *    `window_cap_exceeded`.
   * 4. If any call is blocked or undetermined, the overall batch `admissible` is false.
   *
   * Staging state is fail-closed. An explicit `initialWindowSpent` (including
   * `0n`) is a caller snapshot and is trusted; an absent `Window` ledger entry
   * means no spend has been committed yet. A *failed* policy or window read is
   * different: when a positive transfer needs that state, the affected calls
   * are reported `undetermined` and the batch is never reported admissible from
   * missing state. Non-transfer calls, and batches whose known cap is zero, do
   * not need the snapshot and are unaffected.
   *
   * Documented approximation vs true batch simulation:
   * This sequential simulation with staged window accounting is an off-chain approximation
   * of the contract's atomic auth batch evaluation:
   * - State mutations between calls (other than guard window spend) are not observed during
   *   independent simulations.
   * - Window entries are staged against the initial window snapshot without modelling intra-batch
   *   time expiration.
   * - Total estimated resource fee is the sum of per-call estimates rather than a single
   *   transaction envelope's resource fee.
   *
   * Note cross-dependency:
   * When contract-side `check_batch` lands in `stellar-agent-guard-contracts`, `checkBatch`
   * will route to that entrypoint for atomic on-chain simulation, and this sequential
   * staging implementation will serve as the fallback for contracts on earlier ABI versions.
   */
  async checkBatch(
    calls: ContractCall[],
    options?: CheckBatchOptions,
  ): Promise<PreFlightBatchDecision> {
    if (options?.deadlineMs !== undefined) {
      if (
        typeof options.deadlineMs !== "number" ||
        !Number.isFinite(options.deadlineMs) ||
        options.deadlineMs <= 0
      ) {
        throw new RangeError(
          "checkBatch deadlineMs must be a positive finite number of milliseconds",
        );
      }
    }

    // One absolute budget for the whole batch, measured on the interceptor's
    // injected clock. It is checked before each call starts, and again when a
    // call finishes: a verdict that arrives after the budget is spent cannot
    // make the batch admissible, so it is replaced by the fail-closed timeout.
    const deadlineAt =
      options?.deadlineMs === undefined ? undefined : this.clock.now() + options.deadlineMs;
    const deadlineExpired = (): boolean =>
      deadlineAt !== undefined && this.clock.now() >= deadlineAt;
    const deadlineVerdict = (): PreFlightDecision => {
      const error = new RpcTimeoutError({
        stage: "pre-flight",
        aborted: false,
        deadline: true,
        ...(options?.deadlineMs !== undefined ? { timeoutMs: options.deadlineMs } : {}),
      });
      return {
        allowed: false,
        kind: "undetermined",
        detail: error.message,
        error,
      };
    };

    if (calls.length === 0) {
      return {
        admissible: true,
        overallAdmissible: true,
        kind: "admissible",
        verdicts: [],
        calls: [],
        totalEstimatedResourceFee: 0n,
      };
    }

    // Resolve policy and committed window spend. `undefined` means "not
    // supplied"; an explicit `null` policy is a caller decision that there is
    // no policy to enforce, not a missing read.
    const suppliedPolicy =
      options?.policy !== undefined ? options.policy : this.config.policy;
    const suppliedWindowSpent = options?.initialWindowSpent;

    let policy: ReadonlyPolicyConfig | null = suppliedPolicy ?? null;
    let policyStatus: BatchStagingSource = suppliedPolicy === undefined ? "unavailable" : "provided";
    let policyReadError: unknown;

    let initialWindowSpent = suppliedWindowSpent ?? 0n;
    let windowStatus: BatchStagingSource =
      suppliedWindowSpent === undefined ? "unavailable" : "provided";
    let windowReadError: unknown;

    if (suppliedPolicy === undefined || suppliedWindowSpent === undefined) {
      // Read the missing entries independently: one failed read must not hide a
      // successful read of the other, and the result must distinguish an absent
      // entry (a definitive zero/no-policy answer) from an RPC failure.
      const [policyRead, windowRead] = await Promise.allSettled([
        suppliedPolicy === undefined
          ? readPersistentEntry(this.config.server, this.config.guard, "Policy")
          : Promise.resolve(null),
        suppliedWindowSpent === undefined
          ? readPersistentEntry(this.config.server, this.config.guard, "Window")
          : Promise.resolve(null),
      ]);

      if (suppliedPolicy === undefined) {
        if (policyRead.status === "rejected") {
          policyReadError = policyRead.reason;
        } else if (policyRead.value === null) {
          policyStatus = "absent";
        } else if (policyRead.value.value && typeof policyRead.value.value === "object") {
          policy = policyRead.value.value as ReadonlyPolicyConfig;
          policyStatus = "ledger";
        } else {
          // A present but malformed policy is not evidence of "no cap".
          policyStatus = "unavailable";
          policyReadError = new Error("Policy ledger entry did not contain a policy object");
        }
      }

      if (suppliedWindowSpent === undefined) {
        if (windowRead.status === "rejected") {
          windowReadError = windowRead.reason;
        } else if (windowRead.value === null) {
          initialWindowSpent = 0n;
          windowStatus = "absent";
        } else if (windowRead.value.value && typeof windowRead.value.value === "object") {
          try {
            const windowValue = windowRead.value.value as { total?: bigint | number };
            initialWindowSpent = BigInt(windowValue.total ?? 0);
            windowStatus = "ledger";
          } catch (error) {
            windowReadError = error;
            windowStatus = "unavailable";
          }
        } else {
          // A present but malformed window entry is not evidence of zero spend.
          windowStatus = "unavailable";
          windowReadError = new Error("Window ledger entry did not contain a window object");
        }
      }
    }

    let stagedWindowSpent = 0n;
    let totalEstimatedResourceFee = 0n;
    const verdicts: PreFlightDecision[] = [];
    let stagingRequired = false;
    let stagingUnavailableDetail: string | undefined;
    let stagingUnavailableError: unknown;

    const describeUnavailable = (source: string, error: unknown): string => {
      const reason = error instanceof Error ? `: ${error.message}` : "";
      return (
        `batch staging state unavailable: could not read the guard ${source}${reason}; ` +
        "the rolling window cap cannot be evaluated for this transfer"
      );
    };

    for (const call of calls) {
      // The budget is spent: start no further simulation and report every
      // remaining call fail-closed. Recording the verdict here (rather than
      // `break`) keeps `verdicts` aligned with `calls`.
      if (deadlineExpired()) {
        verdicts.push(deadlineVerdict());
        continue;
      }
      // A single check cannot outlive the batch budget: cap its per-call
      // timeout by the remaining time (and use the remaining budget when no
      // per-call timeout was supplied).
      const remainingMs =
        deadlineAt === undefined ? undefined : Math.max(1, Math.ceil(deadlineAt - this.clock.now()));
      const perCallTimeoutMs =
        remainingMs === undefined
          ? options?.timeoutMs
          : options?.timeoutMs === undefined || options.timeoutMs === 0
            ? remainingMs
            : Math.min(options.timeoutMs, remainingMs);
      const checkOptions: PreFlightCheckOptions = {
        ...(options?.onStep ? { onStep: options.onStep } : {}),
        ...(options?.signal !== undefined ? { signal: options.signal } : {}),
        ...(perCallTimeoutMs !== undefined ? { timeoutMs: perCallTimeoutMs } : {}),
      };

      let decision = await this.check(call, checkOptions);

      // A verdict that landed after the budget was spent is not a usable
      // batch result: the caller has no time left to act on it. A blocked
      // verdict keeps its kind because it is definitive either way.
      if (decision.kind !== "blocked" && deadlineExpired()) {
        decision = deadlineVerdict();
      }

      if (decision.kind === "admissible") {
        const amount = extractTransferAmount(call);

        if (amount !== null && amount > 0n) {
          const windowCap = policy?.window_cap ?? 0n;
          const policyKnown = policyStatus !== "unavailable";

          if (!policyKnown) {
            stagingRequired = true;
            stagingUnavailableDetail ??= describeUnavailable("policy", policyReadError);
            stagingUnavailableError ??= policyReadError;
          } else if (windowCap > 0n) {
            stagingRequired = true;
            if (windowStatus === "unavailable") {
              stagingUnavailableDetail ??= describeUnavailable(
                "committed window spend",
                windowReadError,
              );
              stagingUnavailableError ??= windowReadError;
            }
          }

          if (stagingUnavailableDetail !== undefined) {
            // The individual simulation is admissible, but a batch verdict
            // cannot be staged from state we do not have. Report it as
            // undetermined rather than silently staging against zero.
            verdicts.push({
              allowed: false,
              kind: "undetermined",
              detail: stagingUnavailableDetail,
              error:
                stagingUnavailableError instanceof GuardError
                  ? stagingUnavailableError
                  : new SimulationError(stagingUnavailableDetail, {
                      stage: "preflight",
                      ...(stagingUnavailableError === undefined
                        ? {}
                        : { cause: stagingUnavailableError }),
                    }),
            });
            continue;
          }

          if (windowCap > 0n) {
            const projectedSpend = initialWindowSpent + stagedWindowSpent + amount;
            if (projectedSpend > windowCap) {
              verdicts.push({
                allowed: false,
                kind: "blocked",
                reason: "window_cap_exceeded",
                explanation: explainReason("window_cap_exceeded"),
                detail: `staged window cap exceeded: cumulative spend ${projectedSpend} > window_cap ${windowCap}`,
                diagnosticEvents: [],
              });
              continue;
            }
            stagedWindowSpent += amount;
          }
        }

        verdicts.push(decision);
        totalEstimatedResourceFee += decision.estimatedResourceFee;
      } else {
        verdicts.push(decision);
      }
    }

    const hasBlocked = verdicts.some((verdict) => verdict.kind === "blocked");
    const undeterminedVerdict = verdicts.find((verdict) => verdict.kind === "undetermined");
    const kind: PreFlightBatchDecision["kind"] = hasBlocked
      ? "blocked"
      : undeterminedVerdict
        ? "undetermined"
        : "admissible";

    return {
      admissible: kind === "admissible",
      overallAdmissible: kind === "admissible",
      kind,
      ...(kind === "undetermined" && undeterminedVerdict?.kind === "undetermined"
        ? { detail: undeterminedVerdict.detail }
        : {}),
      verdicts,
      calls: verdicts,
      totalEstimatedResourceFee,
      ...(stagingRequired || windowStatus !== "unavailable"
        ? {
            staging: {
              windowSpent: windowStatus === "unavailable" ? null : initialWindowSpent,
              source: windowStatus,
              unavailable: stagingUnavailableDetail !== undefined,
            },
          }
        : {}),
    };
  }

  /**
   * Populate the cache deliberately for a known set of calls.
   *
   * Runs each call through the same `check()` path, so warming uses exactly the
   * cache a later check would consult: the same ledger marker, TTL, policy
   * revision and `maxEntries` eviction. Only cacheable `admissible` and
   * `blocked` verdicts are stored; `undetermined` verdicts are not (and never
   * were). A blocked or undetermined call is reported in the summary, never
   * thrown.
   *
   * Warming is an optimization, not a guarantee: a warmed verdict can be stale
   * or evicted before the call it was meant for, and another process does not
   * share this cache. With caching disabled by config (`cache` omitted) nothing
   * is stored and `cached` is `0`.
   */
  async warmCache(
    calls: ContractCall[],
    options?: WarmCacheOptions,
  ): Promise<WarmCacheSummary> {
    const startedAt = this.clock.now();
    let cached = 0;
    let blocked = 0;
    let undetermined = 0;

    for (const call of calls) {
      const hitsBefore = this._hits;
      const storesBefore = this._stores;
      const decision = await this.check(call, options);
      if (decision.kind === "undetermined") {
        undetermined += 1;
        continue;
      }
      if (decision.kind === "blocked") blocked += 1;
      // "Cached" means a later check can reuse this verdict: either this pass
      // stored it, or it was already served from the cache.
      if (this._hits > hitsBefore || this._stores > storesBefore) cached += 1;
    }

    return {
      attempted: calls.length,
      cached,
      blocked,
      undetermined,
      durationMs: this.clock.now() - startedAt,
    };
  }

  /**
   * Convenience for adapters that want a throw-on-refusal shape.
   *
   * Throws `GuardBlockedError` on `blocked`, and `GuardUndeterminedError` on
   * `undetermined` or transport failures — an interceptor that returned happily
   * on `undetermined` would hand an agent a green light the chain never gave.
   * Never lets a raw non-Guard error escape.
   */
  async assertAllowed(call: ContractCall): Promise<PreFlightDecision & { allowed: true }> {
    let decision: PreFlightDecision;
    try {
      decision = await this.check(call);
    } catch (cause) {
      if (cause instanceof InvalidInputError) {
        throw cause;
      }
      if (cause instanceof GuardBlockedError || cause instanceof GuardUndeterminedError) {
        throw cause;
      }
      const message = cause instanceof Error ? cause.message : String(cause);
      throw new GuardUndeterminedError(message, {
        stage: "preflight",
        cause,
        detail: message,
      });
    }

    if (decision.allowed) return decision;
    if (decision.kind === "blocked") {
      const rawEvent = decision.diagnosticEvents?.[0];
      throw new GuardBlockedError({
        reason: decision.reason,
        stage: "preflight",
        detail: decision.detail,
        call,
        rawEvent,
      });
    }
    throw new GuardUndeterminedError(decision.detail, {
      stage: "preflight",
      cause: decision.error,
      detail: decision.detail,
    });
  }

  /**
   * Convenience for adapters that want a throw-on-refusal shape for batches.
   *
   * Throws `GuardBlockedError` if any call in the batch is blocked, or
   * `GuardUndeterminedError` if any call is undetermined or a transport error occurs.
   * Never lets a raw non-Guard error escape.
   */
  async assertBatchAllowed(
    calls: ContractCall[],
    options?: CheckBatchOptions,
  ): Promise<PreFlightBatchDecision & { admissible: true }> {
    let decision: PreFlightBatchDecision;
    try {
      decision = await this.checkBatch(calls, options);
    } catch (cause) {
      if (cause instanceof InvalidInputError) {
        throw cause;
      }
      if (cause instanceof GuardBlockedError || cause instanceof GuardUndeterminedError) {
        throw cause;
      }
      const message = cause instanceof Error ? cause.message : String(cause);
      throw new GuardUndeterminedError(message, {
        stage: "preflight",
        cause,
        detail: message,
      });
    }

    if (decision.admissible) return decision as PreFlightBatchDecision & { admissible: true };
    for (const verdict of decision.verdicts) {
      if (verdict.kind === "blocked") {
        throw new GuardBlockedError({
          reason: verdict.reason,
          stage: "preflight",
          detail: verdict.detail,
        });
      }
      if (verdict.kind === "undetermined") {
        throw new GuardUndeterminedError(verdict.detail, {
          stage: "preflight",
          ...(verdict.error === undefined ? {} : { cause: verdict.error }),
          detail: verdict.detail,
        });
      }
    }
    throw new GuardUndeterminedError(
      decision.kind === "undetermined" && decision.detail !== undefined
        ? decision.detail
        : "batch refused by guardrails",
      { stage: "preflight" },
    );
  }

  /**
   * Get a snapshot of the cache statistics.
   * @returns An object with hits, misses, invalidations, and size.
   */
  getCacheStats() {
    return {
      hits: this._hits,
      misses: this._misses,
      invalidations: this._invalidations,
      size: this.cache.size,
    };
  }
}

/** One-shot form, for callers that do not want to hold an interceptor. */
export function preflight(config: PreFlightConfigInput, call: ContractCall): Promise<PreFlightDecision> {
  return new PreFlightInterceptor(config).check(call);
}

/** One-shot form for batch pre-flight checks. */
export function preflightBatch(
  config: PreFlightConfigInput,
  calls: ContractCall[],
  options?: CheckBatchOptions,
): Promise<PreFlightBatchDecision> {
  return new PreFlightInterceptor(config).checkBatch(calls, options);
}

