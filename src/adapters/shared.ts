/**
 * The adapter primitive shared by every framework adapter.
 *
 * A block is not only an agent-facing halt. When middleware refuses an action,
 * the agent's own transcript shows a refusal — but the human watching a
 * dashboard, a log, or an alert channel usually learns nothing (the telemetry
 * tail is a separate opt-in). `onBlocked` is the operator-facing half of a
 * refusal, and `runBlockedHook` is the one place that fires it, so the
 * LangChain, ElizaOS and MCP adapters call the same code instead of carrying
 * three copies of the same try/catch. The issue that introduced this explicitly
 * requires no copy-paste between adapters.
 *
 * The hook is advisory by construction: it is called *after* the adapter has
 * already decided to halt, and a throwing hook is swallowed and logged. A
 * failure in an alerting sink must never turn a clean refusal into a thrown
 * error, and must never turn a halt into an executed action.
 */
import type { PreFlightDecision } from "../preflight.ts";
import type { ContractCall } from "../tx.ts";

/**
 * Which adapter observed the halt. This is the payload's `adapter` field, so an
 * operator sink that receives blocks from several frameworks can tell them
 * apart without inspecting the call.
 */
export type GuardAdapterName = "langchain" | "elizaos" | "mcp";

/**
 * The structured payload handed to `onBlocked`.
 *
 * `reason` and `explanation` mirror the guard's own `blocked` verdict. Failing
 * closed also covers the third verdict: when enforcement cannot reach a
 * decision (`undetermined` — a contract trap, a missing trustline, an invalid
 * resource fee), the adapter still halts, so the hook still fires. `kind`
 * distinguishes the two arms and `reason` is `null` on the undetermined one,
 * while `explanation` carries the failure detail, so a consumer never has to
 * guess whether the guard actually refused the call.
 */
export interface GuardBlockedInfo {
  /** The adapter that halted the action. */
  adapter: GuardAdapterName;
  /** `blocked` = the guard refused; `undetermined` = the guard never ruled. */
  kind: "blocked" | "undetermined";
  /** The guard's reason symbol for a `blocked` verdict; `null` otherwise. */
  reason: string | null;
  /** The contract call the guard ruled on (or could not rule on). */
  call: ContractCall;
  /** Human-readable one-line meaning; the failure detail when undetermined. */
  explanation: string;
  /**
   * Every call in the mapped batch, in the order the adapter checked them.
   * Present only when the halt came from a batch mapping (`toContractCalls`),
   * so a single-call payload is unchanged (additive, issue #318).
   */
  calls?: readonly ContractCall[];
  /**
   * Per-call verdicts aligned with `calls`, in the same order. Present only for
   * a batch halt; `call`/`kind`/`reason` describe the first non-admissible
   * verdict (additive, issue #318).
   */
  verdicts?: readonly PreFlightDecision[];
}

/**
 * Operator alerting hook. Intended for webhook/log/alert wiring by the
 * integrator; see `runBlockedHook` for the isolation guarantee.
 */
export type GuardBlockedHook = (info: GuardBlockedInfo) => void;

/**
 * Where a swallowed hook failure is reported, when the host opts in.
 *
 * There is deliberately no `console` default: the SDK stays silent unless the
 * host supplies a sink (design-principles §6, issue #314).
 */
export interface BlockedHookLogger {
  error(message: string, ...rest: unknown[]): void;
}

/**
 * Map one agent action to the ordered contract calls it would make.
 *
 * `toContractCalls` is the additive batch form (issue #318): when supplied it
 * takes precedence over `toContractCall`, and the adapter checks the complete
 * batch before the handler runs. Returning `null` or an empty array means the
 * action is not fund-moving and passes through untouched.
 */
export interface GuardCallMapper<T> {
  /** Single-call mapping (the pre-existing form). */
  toContractCall?: (request: T) => ContractCall | null;
  /** Ordered batch mapping; takes precedence over `toContractCall`. */
  toContractCalls?: (request: T) => readonly ContractCall[] | null;
}

/**
 * Resolve the ordered calls an adapter should check for one action.
 *
 * An empty result means "not fund-moving", never "allowed": the adapter must
 * pass the action through without inventing a verdict, exactly as the
 * single-call `null` return already did.
 */
export function mapContractCalls<T>(request: T, mapper: GuardCallMapper<T>): ContractCall[] {
  if (mapper.toContractCalls) {
    const calls = mapper.toContractCalls(request);
    return calls ? [...calls] : [];
  }
  const call = mapper.toContractCall?.(request);
  return call ? [call] : [];
}

/**
 * Build the operator payload from a non-allowed decision.
 *
 * Shared so the field list (and the undetermined mapping) cannot drift between
 * adapters: a new field added here reaches every framework at once.
 */
export function blockedInfoFor(
  adapter: GuardAdapterName,
  call: ContractCall,
  decision: PreFlightDecision & { allowed: false },
): GuardBlockedInfo {
  if (decision.kind === "blocked") {
    return {
      adapter,
      kind: "blocked",
      reason: decision.reason,
      call,
      explanation: decision.explanation,
    };
  }
  return {
    adapter,
    kind: "undetermined",
    reason: null,
    call,
    explanation: decision.detail,
  };
}

/**
 * Build the operator payload for a batch halt.
 *
 * `call`, `kind`, `reason` and `explanation` are those of the first
 * non-admissible verdict, so an existing single-call consumer keeps a usable
 * payload; `calls` and `verdicts` carry the full ordered batch for a consumer
 * that needs per-call detail (issue #318).
 */
export function blockedInfoForBatch(
  adapter: GuardAdapterName,
  calls: readonly ContractCall[],
  verdicts: readonly PreFlightDecision[],
): GuardBlockedInfo {
  const index = verdicts.findIndex((verdict) => !verdict.allowed);
  const decision = verdicts[index] ?? verdicts[0];
  const call = calls[index] ?? calls[0];
  if (!decision || decision.allowed || !call) {
    throw new Error("blockedInfoForBatch requires an ordered batch with a refusal");
  }
  return {
    ...blockedInfoFor(adapter, call, decision),
    calls: [...calls],
    verdicts: [...verdicts],
  };
}

/**
 * Fire the operator hook exactly once, isolating it from the halt path.
 *
 * Absent hook → nothing happens, which is precisely the adapter's behavior
 * before this option existed. A throwing hook is swallowed rather than
 * propagated: the refusal has already been decided, and an alerting sink that
 * is down must not change what the agent is allowed to do.
 *
 * Absent `logger` → the failure is swallowed silently. That is deliberate:
 * SDK output is opt-in only, so there is no `console` fallback (issue #314). A
 * host that wants the diagnostic passes an explicit sink, and the log line
 * names the adapter so a failing webhook can be traced without the payload.
 */
export function runBlockedHook(
  hook: GuardBlockedHook | undefined,
  info: GuardBlockedInfo,
  logger?: BlockedHookLogger,
): void {
  if (!hook) return;
  try {
    hook(info);
  } catch (error) {
    logger?.error(
      `stellar-agent-guard: the ${info.adapter} adapter's onBlocked callback threw; the halt stands and the action was not executed.`,
      error,
    );
  }
}
