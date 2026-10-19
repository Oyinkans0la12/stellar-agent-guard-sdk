/**
 * LangChain adapter — built on `AgentMiddleware.wrapToolCall`.
 *
 * The hook is the *continuation* form: `wrapToolCall(request, handler)` is handed
 * the tool execution as a callback, so a middleware that returns without calling
 * `handler(request)` means the tool body never runs. That is what makes this a
 * genuine pre-execution block rather than observability. See
 * `docs/integration-hooks.md` $1 for the source-pinned signatures.
 *
 * Do **not** use the older callback system (`on_tool_start` / `onToolStart`):
 * those observe a call that has already been dispatched and cannot stop it.
 *
 * The adapter deliberately does not import `@langchain/core`. It is written
 * structurally against the hook's shape so that installing this SDK does not drag
 * a framework in, and so it keeps working across minor framework versions. The
 * one thing it does need from the host is how to turn a tool call into a guarded
 * contract call — which is application knowledge, supplied as `toContractCall`.
 *
 * ## Verdict handling (documented contract)
 *
 * The adapter maps every `PreFlightDecision` kind to a defined result:
 *
 * | Verdict                | Adapter behavior                                                |
 * | ---------------------- | ------------------------------------------------------------------------ |
 * | `admissible`           | calls `handler(request)` — the tool runs unchanged.                    |
 * | `blocked(reason`)      | returns a `LangChainToolMessage` with `status: "error"`; the tool never runs.  |
 * | `undetermined(cause)` | returns a `LangChainToolMessage` with `status: "error"`; the tool never runs.  |
 *
 * The adapter never throws for a guard verdict — it fails closed by returning a
 * refusal message. This differs from the ElizaOS validator, which returns a boolean
 * and fails closed (returns `false`) on `undetermined`; the shared harness in
 * `tests/integration/adapters.test.ts` pins both contracts side by side.
 * Options are validated at construction time (see `src/adapters/validate.ts`):
 * a misconfigured adapter throws `AdapterConfigError` before any action runs,
 * rather than failing mid-loop on the first tool call.
 */
import type { InvokeStepEvent } from "../invoke.ts";
import type { PreFlightDecision, PreFlightInterceptor } from "../preflight.ts";
import type { ContractCall } from "../tx.ts";
import {
  throwAdapterConfigError,
  validateBatchInterceptor,
  validateBlockedHookLogger,
  validateContractMapping,
  validateInterceptor,
  validateOptionalFunction,
  type AdapterConfigIssue,
} from "./validate.ts";
import {
  blockedInfoFor,
  blockedInfoForBatch,
  mapContractCalls,
  runBlockedHook,
  type BlockedHookLogger,
  type GuardBlockedHook,
} from "./shared.ts";

/** The subset of LangChain's `ToolCallRequest` this adapter reads. */
export interface LangChainToolCallRequest {
  toolCall: {
    name: string;
    args: Record<string, unknown>;
    id?: string;
  };
}

/** The shape this adapter returns in place of the tool's own result. */
export interface LangChainToolMessage {
  content: string;
  name: string;
  tool_call_id: string;
  /** Marker so a host can tell a refusal from a tool's own output. */
  status: "error";
}

export interface LangChainGuardOptions {
  interceptor: PreFlightInterceptor;
  /**
   * Turn a tool call into the guarded contract call it would make, or `null` if
   * this tool does not move funds and should not be intercepted at all.
   */
  toContractCall?: (request: LangChainToolCallRequest) => ContractCall | null;
  /**
   * Additive batch mapping (issue #318): the ordered calls one action performs.
   * Supplying this takes precedence over `toContractCall`, and the entire batch
   * is checked before the tool body runs (all-or-nothing). `null` or an empty
   * array means the tool is not fund-moving.
   */
  toContractCalls?: (request: LangChainToolCallRequest) => readonly ContractCall[] | null;
  /** Middleware name; also the returned message's `name`. */
  name?: string;
  /** Observe every decision — the place to wire telemetry. */
  onDecision?: (request: LangChainToolCallRequest, decision: PreFlightDecision) => void;
  /**
   * Operator alerting: called once per halt with a structured payload
   * (`{ adapter, kind, reason, call, explanation }`), so a refusal reaches a
   * webhook/log/dashboard rather than only the agent's transcript. Fires for a
   * guard `blocked` verdict and for a fail-closed `undetermined` one, since both
   * stop the tool body from running. A throwing callback is logged and
   * swallowed — it never changes the halt. Omit it for the pre-existing
   * behavior. See `src/adapters/shared.ts`.
   */
  onBlocked?: GuardBlockedHook;
  /**
   * Explicit sink for a swallowed `onBlocked` failure. Omitted (the default),
   * a throwing hook is silent — the SDK never writes to `console` on its own
   * (issue #314).
   */
  blockedHookLogger?: BlockedHookLogger;
  /**
   * Optional per-call observability, forwarded to the interceptor's
   * `check()`: one event per enforcement-stage attempt (probe → sign →
   * simulate) with timing, on the same shared step vocabulary and event shape
   * as `invoke()`'s `onStep`. The adapter never broadcasts, so no `broadcast`
   * events can appear here. Omitting it changes nothing.
   */
  onStep?: (step: InvokeStepEvent) => void;
}

/**
 * A Mapper that turns a `PreFlightDecision` into the adapter's return value.
 *
 * Exposed so the shared harness can assert the documented mapping for each
 * verdict without driving the full middleware composition.
 */
export function mapDecisionToLangChainResult(
  decision: PreFlightDecision,
  toolName: string,
  name: string,
  toolCallId: string,
): LangChainToolMessage {
  return {
    content: describeRefusal(decision as PreFlightDecision & { allowed: false }, toolName),
    name,
    tool_call_id: toolCallId,
    status: "error",
  };
}

/**
 * A middleware whose `wrapToolCall` asks the guard before the tool runs.
 *
 * Register it first: LangChain composes middleware with *"third defined =
 * outermost"*, so ordering it ahead of other tool middleware means the guard
 * decides before anything else touches the call.
 */
export function createLangChainGuardMiddleware(options: LangChainGuardOptions) {
  const issues: AdapterConfigIssue[] = [];
  const interceptorIssue = validateInterceptor(options.interceptor);
  if (interceptorIssue) issues.push(interceptorIssue);
  issues.push(...validateContractMapping(options));
  if (options.toContractCalls) {
    const batchIssue = validateBatchInterceptor(options.interceptor);
    if (batchIssue) issues.push(batchIssue);
  }
  const blockedLoggerIssue = validateBlockedHookLogger(options.blockedHookLogger);
  if (blockedLoggerIssue) issues.push(blockedLoggerIssue);
  const nameIssue = validateOptionalFunction("name", options.name);
  if (nameIssue) issues.push(nameIssue);
  const onDecisionIssue = validateOptionalFunction("onDecision", options.onDecision);
  if (onDecisionIssue) issues.push(onDecisionIssue);
  const onStepIssue = validateOptionalFunction("onStep", options.onStep);
  if (onStepIssue) issues.push(onStepIssue);
  throwAdapterConfigError("langchain", issues);

  const name = options.name ?? "stellar-agent-guard";

  return {
    name,
    async wrapToolCall<T>(
      request: LangChainToolCallRequest,
      handler: (request: LangChainToolCallRequest) => Promise<T>,
    ): Promise<T | LangChainToolMessage> {
      const calls = mapContractCalls(request, options);
      if (calls.length === 0) {
        // Not a fund-moving tool. Pass through untouched rather than inventing a
        // verdict for something the guard has no opinion about.
        return handler(request);
      }

      if (calls.length === 1) {
        const decision = await options.interceptor.check(calls[0]!, {
          ...(options.onStep ? { onStep: options.onStep } : {}),
        });
        options.onDecision?.(request, decision);
        if (decision.allowed) return handler(request);

        // Operator-facing half of the refusal, wired through the shared primitive
        // so this adapter and ElizaOS cannot drift on the payload shape.
        runBlockedHook(
          options.onBlocked,
          blockedInfoFor("langchain", calls[0]!, decision),
          options.blockedHookLogger,
        );

        // The tool is never entered: no signing, no broadcast, no fee.
        // Both `blocked` and `undetermined` fail closed to a refusal message.
        return mapDecisionToLangChainResult(
          decision,
          request.toolCall.name,
          name,
          request.toolCall.id ?? "",
        );
      }

      // Batch mapping: check every call before entering the tool. The interceptor
      // reports one verdict per call in order; a single non-admissible verdict
      // refuses the whole action (all-or-nothing).
      const batch = await options.interceptor.checkBatch(calls, {
        ...(options.onStep ? { onStep: options.onStep } : {}),
      });
      for (const verdict of batch.verdicts) options.onDecision?.(request, verdict);
      if (batch.admissible) return handler(request);

      runBlockedHook(
        options.onBlocked,
        blockedInfoForBatch("langchain", calls, batch.verdicts),
        options.blockedHookLogger,
      );
      const refusal = batch.verdicts.find((verdict) => !verdict.allowed)!;
      return mapDecisionToLangChainResult(
        refusal,
        request.toolCall.name,
        name,
        request.toolCall.id ?? "",
      );
    },
  };
}

/** Human- and model-readable refusal text, sourced from the contract's reason. */
function describeRefusal(decision: PreFlightDecision & { allowed: false }, toolName: string): string {
  if (decision.kind === "blocked") {
    return (
      `stellar-agent-guard blocked '${toolName}': ${decision.reason} — ${decision.explanation}\n` +
      `No transaction was submitted, so nothing was spent and no fee was paid.`
    );
  }
  return (
    `stellar-agent-guard could not determine whether '${toolName}' is permitted; ` +
    `it was not executed.\n${decision.detail}`
  );
}
