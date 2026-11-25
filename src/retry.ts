/**
 * Public retry vocabulary shared by `invoke()` outcomes and `BroadcastError`.
 *
 * Kept in its own module so `errors.ts` can describe the metadata attached to a
 * failed broadcast without importing `invoke.ts` (which imports `errors.ts`).
 * Nothing here is runtime state: the metadata is deliberately a small, serialisable
 * record of attempt numbers, retryable classes and delays. It never carries
 * secrets, signed payloads, diagnostic events or transaction XDR.
 */

import type { TraceStepName } from "./trace.ts";

/** Failures the invocation pipeline knows how to retry. */
export type RetryableInvokeFailure =
  | "stale_ledger_resource_limit"
  | "sequence_number_collision"
  | "min_fee";

/**
 * Machine-readable causes attached to non-policy `invoke()` failures.
 *
 * `undetermined` deliberately covers errors for which the guard did not make a
 * decision (a bad input, an RPC/host failure, or an unsupported auth shape). It
 * is the same fail-closed category used by pre-flight decisions; it must not be
 * confused with `blocked`, which means the guard actually refused the call.
 */
export type InvokeErrorCause =
  | "undetermined"
  | "stale_ledger_resource_limit"
  | "sequence_number_collision";

/** One retryable failure that led to another pipeline attempt. */
export interface InvokeRetryAttempt {
  /** 1-based attempt number that failed. */
  attempt: number;
  /** Retryable class observed on that attempt. */
  failure: RetryableInvokeFailure;
  /** Coarse cause exposed on the corresponding error outcome. */
  cause: InvokeErrorCause;
  /**
   * Backoff actually applied before the next attempt, in milliseconds.
   * Fee-bump retries re-prepare immediately, so their delay is `0`.
   */
  delayMs: number;
}

/**
 * One retry, as reported to `invoke()`'s `onRetry` hook.
 *
 * Delivered after the backoff has been chosen and **before** the next attempt
 * starts, so an operator can emit a metric or structured log line per retry
 * while the pipeline is still waiting — not only once the call finishes. The
 * event mirrors the corresponding `InvokeRetryMetadata.retries` entry and adds
 * the stage that failed plus the attempt number that runs next.
 *
 * It is safe to log: like the retry metadata, it carries only attempt numbers,
 * retryable-class names and delays — never payloads, XDR or hashes.
 */
export interface InvokeRetryEvent {
  /** 1-based attempt number that failed. */
  attempt: number;
  /** Retryable class observed on that attempt. */
  failure: RetryableInvokeFailure;
  /** Coarse cause the terminal outcome would report for this failure. */
  cause: InvokeErrorCause;
  /**
   * Backoff applied before the next attempt, in milliseconds. Fee-bump retries
   * re-prepare immediately, so their delay is `0`.
   */
  delayMs: number;
  /** 1-based attempt number that will start next. */
  nextAttempt: number;
  /**
   * Pipeline stage where the failure was observed, from the shared
   * `TRACE_STEP_NAMES` vocabulary. Every retryable failure is classified from
   * the broadcast's submission result, so this is `"broadcast"` today.
   */
  stage: TraceStepName;
}

/**
 * Structured retry-attempt metadata for a terminal `invoke()` outcome.
 *
 * Present on every terminal outcome (allowed, blocked, error) and on
 * `InvokeRetryError` / a fee-bump-exhausted `BroadcastError`. It answers the
 * operator questions a bare outcome cannot: how many attempts ran, which
 * retryable classes were recovered from, how long the backoff waited, and
 * whether the terminal attempt ran out of budget.
 *
 * The shape is safe to log: it contains no secrets, signed payloads, full
 * transaction XDR, diagnostic payloads or transaction hashes.
 */
export interface InvokeRetryMetadata {
  /** Total pipeline attempts started, including the first attempt. */
  attempts: number;
  /**
   * The retry budget that applied to the terminal failure class: the general
   * stale-ledger/sequence budget, or the fee-bump budget for `min_fee`.
   */
  maxAttempts: number;
  /** True when at least one retry followed a retryable failure. */
  retried: boolean;
  /** True when the terminal attempt exhausted its retry budget. */
  exhausted: boolean;
  /** Total backoff applied across all retries, in milliseconds. */
  totalDelayMs: number;
  /** Retryable failures that led to another attempt, oldest first. */
  retries: InvokeRetryAttempt[];
  /** Retryable class on the terminal attempt, or null when it ended cleanly. */
  terminalFailure: RetryableInvokeFailure | null;
  /** Coarse cause on the terminal attempt, or null when it ended cleanly. */
  terminalCause: InvokeErrorCause | null;
  /** How the pipeline ended. */
  outcome: "allowed" | "blocked" | "pending" | "error";
  /**
   * `feeBump.maxInclusionFee` that stopped a fee-bump retry, as a decimal
   * stroop string. Present only when the ceiling is what ended the pipeline.
   */
  maxInclusionFeeStroops?: string;
}
