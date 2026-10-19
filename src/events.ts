/**
 * The guard contract's event vocabulary, as confirmed against the chain.
 *
 * This table is not copied from documentation. Phase 2.2 captured real events
 * from the live testnet instance and the topic names disagree with the docs:
 * `stellar-agent-guard-contracts` describes the decision event as
 * `auth_checked` (SPEC §9, `tests/fixtures/README.md` line 86), but Soroban's
 * `#[contractevent]` macro prepends `event_`, and the contract's own fixture log
 * already shows the real name. The live capture proves which one the chain
 * emits:
 *
 *   [Contract Event] topics: [event_auth_checked, blocked, per_tx_cap_exceeded]
 *
 * So every topic here carries the `event_` prefix, matching
 * `stellar-agent-guard-contracts/src/lib.rs`:
 *
 *   #[contractevent] struct EventAuthChecked    => topic[0] = event_auth_checked
 *   #[contractevent] struct EventHeartbeat      => topic[0] = event_heartbeat
 *   #[contractevent] struct EventInitialized    => topic[0] = event_initialized
 *   #[contractevent] struct EventFrozen         => topic[0] = event_frozen
 *   #[contractevent] struct EventUnfrozen       => topic[0] = event_unfrozen
 *   #[contractevent] struct EventPolicySet      => topic[0] = event_policy_set
 *   #[contractevent] struct EventPolicyRevoked  => topic[0] = event_policy_revoked
 *
 * Topic layout for the decision event (the `#[topic]` fields follow the macro's
 * own name): `[event_auth_checked, <allowed|blocked>, <reason symbol>]`. The
 * event carries no data payload (`data: {}`) — the reason lives in the topics,
 * which is why a listener can filter on one vocabulary without decoding bodies.
 *
 * Two details a listener must get right, both observed in the live capture and
 * neither obvious from the docs:
 *
 *   1. On an *allowed* decision the third topic is present but is the **empty
 *      symbol** `""` — not omitted, not null. `decodeAuthDecision` normalises it
 *      to a null reason so callers do not have to know that.
 *   2. A heartbeat is a *separate* event (`event_heartbeat`) whose only topic is
 *      its name; the unix-second timestamp arrives as event **data**, not as a
 *      topic: `data = { at: u64 }`.
 */
import { scValToNative, xdr } from "@stellar/stellar-sdk";
import type { GuardReason } from "./reasons.ts";

export const GUARD_EVENT_TOPICS = {
  /** Every policy decision, in-path and pre-flight. */
  authChecked: "event_auth_checked",
  /** Agent liveness signal; data is the unix-second `at`. */
  heartbeat: "event_heartbeat",
  /** Admin lifecycle events; data is the acting admin `by`. */
  initialized: "event_initialized",
  frozen: "event_frozen",
  unfrozen: "event_unfrozen",
  policySet: "event_policy_set",
  policyRevoked: "event_policy_revoked",
} as const;

/** Index 1 of an `event_auth_checked` topic list: the decision. */
export const GUARD_AUTH_RESULTS = {
  allowed: "allowed",
  blocked: "blocked",
} as const;

export type GuardAuthResult =
  (typeof GUARD_AUTH_RESULTS)[keyof typeof GUARD_AUTH_RESULTS];

/**
 * A guard decision decoded from one contract event, in the shape a telemetry
 * consumer wants. `reason` is only meaningful when `result` is `blocked`, but a
 * rejected transaction rolls back the event, so a blocked decision usually
 * arrives from an enforced simulation's diagnostic events rather than from a
 * ledger.
 */
export interface GuardAuthDecision {
  result: GuardAuthResult;
  reason: GuardReason | null;
  /** Where the event was observed: a committed ledger event, or a pre-broadcast diagnostic. */
  source: "ledger" | "diagnostic";
}

/**
 * Interpret one decoded topic list as a guard decision.
 *
 * Returns null for anything that is not an `event_auth_checked` event, so a
 * caller (and the policy classifier in `invoke.ts`) can distinguish the guard
 * refusing a call from a contract trap that merely looks like a failure.
 *
 * The topic name is matched on the confirmed `event_auth_checked` symbol. The
 * documentation's un-prefixed `auth_checked` is intentionally *not* accepted:
 * tolerating both would hide exactly the drift this module exists to catch.
 */
export function decodeAuthDecision(
  topics: readonly string[],
  source: GuardAuthDecision["source"],
): GuardAuthDecision | null {
  if (topics[0] !== GUARD_EVENT_TOPICS.authChecked) return null;
  const result = topics[1];
  if (result !== GUARD_AUTH_RESULTS.allowed && result !== GUARD_AUTH_RESULTS.blocked) {
    return null;
  }
  // An allowed decision carries the empty symbol as its reason; treat that as
  // "no reason" rather than surfacing `""` to operators.
  const rawReason = topics[2];
  // The contract's reason vocabulary is a closed set (`GuardReason`, derived
  // from `src/reasons.ts`, and pinned to the vendored fixture by
  // `tests/unit/reasons.test.ts`). A symbol outside it is drift the fixture test
  // catches in CI, so the decoded value is surfaced as-is rather than silently
  // dropped here.
  const reason = rawReason && rawReason.length > 0 ? (rawReason as GuardReason) : null;
  return { result, reason, source };
}


/**
 * Normalise a numeric value delivered as a string in an event payload.
 *
 * u64 values arrive as strings in JSON payloads. This centralizes the decision
 * to parse them as BigInt (which never loses precision for >2^53) if they consist
 * entirely of digits, while leaving other strings (like ISO timestamps) intact.
 */
export function normalizeU64(value: string): bigint | string {
  if (/^\d+$/.test(value)) {
    return BigInt(value);
  }
  return value;
}

/** Recursively normalise u64 strings in event data. */
export function normalizeEventData(data: unknown): unknown {
  if (typeof data === "string") {
    return normalizeU64(data);
  }
  if (Array.isArray(data)) {
    return data.map(normalizeEventData);
  }
  if (data !== null && typeof data === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(data)) {
      result[key] = normalizeEventData(value);
    }
    return result;
  }
  return data;
}

/**
 * Decode one topic of a contract event into its symbol text.
 *
 * Topics reach this module in two shapes depending on the caller: as a
 * base64-encoded `xdr.ScVal` string (what a block explorer, a CI fixture, or
 * `getEvents` over JSON hands over) or as an already-decoded `xdr.ScVal`. Both
 * go through `scValToNative` so the text is identical either way.
 *
 * Returns `null` for anything that does not decode, rather than throwing, so a
 * single unrecognised topic rejects the event instead of killing the caller.
 */
function topicToSymbol(topic: unknown): string | null {
  try {
    if (typeof topic === "string") {
      return String(scValToNative(xdr.ScVal.fromXDR(topic, "base64")));
    }
    return String(scValToNative(topic as xdr.ScVal));
  } catch {
    return null;
  }
}

/** The outcome of inspecting an event's topic list, for resilient and strict decoders. */
type TopicInspection =
  | { ok: true; topics: string[] }
  | {
      ok: false;
      stage: "topics" | "topic";
      topicIndex: number | null;
      message: string;
    };

/**
 * Inspect an event's topic list while keeping the precise failure stage.
 *
 * The resilient `topicsFromEvent()` below collapses this to `null`; the strict
 * offline validator needs to say whether the list was missing or one individual
 * topic failed to decode, and where.
 */
function inspectTopics(event: unknown): TopicInspection {
  const wrapper = event as {
    event?: { body?: unknown };
    body?: { v0?: { topics?: unknown[] }; value?: { v0?: { topics?: unknown[] } } };
  } | null;
  const body = (wrapper?.event?.body ?? wrapper?.body) as
    | { v0?: { topics?: unknown[] }; value?: { v0?: { topics?: unknown[] } } }
    | undefined;
  const topics = body?.v0?.topics ?? body?.value?.v0?.topics;
  if (!Array.isArray(topics)) {
    return {
      ok: false,
      stage: "topics",
      topicIndex: null,
      message: "event carries no contract-event topic list",
    };
  }

  const out: string[] = [];
  for (const [index, topic] of topics.entries()) {
    const symbol = topicToSymbol(topic);
    if (symbol === null) {
      return {
        ok: false,
        stage: "topic",
        topicIndex: index,
        message: `topic[${index}] is not a decodable ScVal`,
      };
    }
    out.push(symbol);
  }
  return { ok: true, topics: out };
}

/**
 * Pull the topic list out of a decoded `xdr.ContractEvent` or
 * `xdr.DiagnosticEvent`.
 *
 * A `DiagnosticEvent` wraps the contract event in its `event` field; a
 * `ContractEvent` carries `body.v0.topics` directly.
 */
function topicsFromEvent(event: unknown): string[] | null {
  const inspected = inspectTopics(event);
  return inspected.ok ? inspected.topics : null;
}

/** Parse either XDR wrapper the public decoders accept. */
function parseEventXdr(
  xdrBase64: string,
): { ok: true; event: unknown } | { ok: false; message: string } {
  try {
    return { ok: true, event: xdr.DiagnosticEvent.fromXDR(xdrBase64, "base64") };
  } catch {
    try {
      return { ok: true, event: xdr.ContractEvent.fromXDR(xdrBase64, "base64") };
    } catch {
      return {
        ok: false,
        message: "input is neither a base64 DiagnosticEvent nor a ContractEvent",
      };
    }
  }
}

/**
 * Decode a guard decision from a raw base64 XDR string.
 *
 * This is the offline-tooling entry point: an event XDR pasted from a block
 * explorer, committed as a CI fixture, or dumped while debugging a live
 * incident goes through the same decision decoder as an event observed from a
 * stellar-sdk response, so the two can never drift apart.
 *
 * Accepts either a base64 `DiagnosticEvent` (what `server.getEvents()` and a
 * simulation error carry) or a base64 `ContractEvent` (what a block explorer
 * exposes). The returned `source` therefore defaults to `diagnostic`, since
 * that is the shape the enforced-simulation path produces; pass `"ledger"` when
 * the payload was read from a committed ledger.
 *
 * Returns `null` — never throws — for a malformed base64 string, an XDR that is
 * not a contract event, or an event that is not an `event_auth_checked`
 * decision. That is documented behaviour: fixture checks and operator
 * copy-paste must not be able to crash a long-running process.
 */
export function decodeGuardEventXdr(
  xdrBase64: string,
  source: GuardAuthDecision["source"] = "diagnostic",
): GuardAuthDecision | null {
  if (typeof xdrBase64 !== "string" || xdrBase64.length === 0) return null;

  let event: unknown;
  try {
    event = xdr.DiagnosticEvent.fromXDR(xdrBase64, "base64");
  } catch {
    try {
      event = xdr.ContractEvent.fromXDR(xdrBase64, "base64");
    } catch {
      return null;
    }
  }

  const topics = topicsFromEvent(event);
  if (!topics) return null;
  return decodeAuthDecision(topics, source);
}

/** Pipeline stage at which strict offline validation rejected an input. */
export type GuardEventValidationStage = "input" | "xdr" | "topics" | "topic" | "decision";

/** Stable, machine-readable reason a strict validation input was rejected. */
export type GuardEventValidationCode =
  | "input.not_string"
  | "input.empty"
  | "xdr.unparseable"
  | "topics.missing"
  | "topic.undecodable"
  | "decision.unknown_topic"
  | "decision.invalid_result";

/** Options for `validateGuardEventXdr()`. */
export interface GuardEventValidationOptions {
  /** Source recorded on each successfully decoded decision. Defaults to `diagnostic`. */
  source?: GuardAuthDecision["source"];
  /** Base path used in failure messages. Defaults to `events`. */
  path?: string;
}

/** One input that strict offline validation accepted. */
export interface GuardEventValidationSuccess {
  index: number;
  path: string;
  decision: GuardAuthDecision;
}

/** One input that strict offline validation rejected. */
export interface GuardEventValidationFailure {
  /** Position of the input in the validated array. */
  index: number;
  /**
   * Stable dotted path to the failing field, e.g. `events[2]` for an XDR parse
   * failure or `events[2].topics[0]` for an unknown name topic.
   */
  path: string;
  /** Stage of the decode pipeline that rejected the input. */
  stage: GuardEventValidationStage;
  /** Stable code for this failure mode; safe to branch on. */
  code: GuardEventValidationCode;
  /** Human-readable detail for logs and fixture diffs. */
  message: string;
}

/** The per-input outcome, in the same order as the validated inputs. */
export type GuardEventValidationEntry =
  | (GuardEventValidationSuccess & { ok: true })
  | (GuardEventValidationFailure & { ok: false });

/** The result of strict offline validation over a batch of XDR inputs. */
export interface GuardEventValidationReport {
  /** True only when every input decoded to a guard decision. */
  ok: boolean;
  /** One entry per input, in input order. */
  results: GuardEventValidationEntry[];
  /** Successfully decoded decisions, in input order. */
  events: GuardAuthDecision[];
  /** Every rejection, in input order. */
  failures: GuardEventValidationFailure[];
}

type StrictDecodeOutcome =
  | { ok: true; decision: GuardAuthDecision }
  | {
      ok: false;
      stage: GuardEventValidationStage;
      code: GuardEventValidationCode;
      message: string;
      topicIndex?: number;
    };

/**
 * Strictly decode one XDR input, reporting the precise failure stage instead of
 * returning `null`.
 */
function strictDecodeGuardEventXdr(
  input: unknown,
  source: GuardAuthDecision["source"],
): StrictDecodeOutcome {
  if (typeof input !== "string") {
    return {
      ok: false,
      stage: "input",
      code: "input.not_string",
      message: `input must be a base64 XDR string, received ${typeof input}`,
    };
  }
  if (input.length === 0) {
    return {
      ok: false,
      stage: "input",
      code: "input.empty",
      message: "input is an empty string",
    };
  }

  const parsed = parseEventXdr(input);
  if (!parsed.ok) {
    return { ok: false, stage: "xdr", code: "xdr.unparseable", message: parsed.message };
  }

  const topics = inspectTopics(parsed.event);
  if (!topics.ok) {
    return {
      ok: false,
      stage: topics.stage,
      code: topics.stage === "topics" ? "topics.missing" : "topic.undecodable",
      message: topics.message,
      ...(topics.topicIndex !== null ? { topicIndex: topics.topicIndex } : {}),
    };
  }

  const decision = decodeAuthDecision(topics.topics, source);
  if (decision === null) {
    if (topics.topics[0] !== GUARD_EVENT_TOPICS.authChecked) {
      return {
        ok: false,
        stage: "decision",
        code: "decision.unknown_topic",
        message: `name topic ${JSON.stringify(topics.topics[0] ?? "")} is not ${GUARD_EVENT_TOPICS.authChecked}`,
        topicIndex: 0,
      };
    }
    return {
      ok: false,
      stage: "decision",
      code: "decision.invalid_result",
      message: `decision result ${JSON.stringify(topics.topics[1] ?? "")} is neither allowed nor blocked`,
      topicIndex: 1,
    };
  }
  return { ok: true, decision };
}

/**
 * Strict, offline validation for captured event XDR fixtures.
 *
 * This is deliberately separate from `decodeGuardEventXdr()`. The live decode
 * entry points stay resilient — they return `null` or drop an unrecognised
 * event so a long-running monitor cannot be killed by one bad payload. A
 * fixture maintainer needs the opposite guarantee: every input is accounted
 * for, and a failure says exactly which input failed and at which stage.
 *
 * The report preserves input order. Successful decisions land in `events`;
 * every rejection lands in `failures` with a stable `index`, `stage`, `code`,
 * and `path`. See `docs/api/telemetry-listener.md` for the stage vocabulary.
 *
 * ```ts
 * const report = validateGuardEventXdr(fixtureXdr, { source: "ledger" });
 * if (!report.ok) {
 *   for (const failure of report.failures) {
 *     recordFailure(failure.path, failure.stage, failure.code, failure.message);
 *   }
 * }
 * ```
 */
export function validateGuardEventXdr(
  inputs: readonly unknown[],
  options: GuardEventValidationOptions = {},
): GuardEventValidationReport {
  const source = options.source ?? "diagnostic";
  const basePath = options.path ?? "events";
  const results: GuardEventValidationEntry[] = [];
  const events: GuardAuthDecision[] = [];
  const failures: GuardEventValidationFailure[] = [];

  for (const [index, input] of inputs.entries()) {
    const path = `${basePath}[${index}]`;
    const outcome = strictDecodeGuardEventXdr(input, source);
    if (outcome.ok) {
      results.push({ ok: true, index, path, decision: outcome.decision });
      events.push(outcome.decision);
      continue;
    }

    const failure: GuardEventValidationFailure = {
      index,
      path:
        outcome.topicIndex !== undefined
          ? `${path}.topics[${outcome.topicIndex}]`
          : outcome.stage === "topics"
            ? `${path}.topics`
            : path,
      stage: outcome.stage,
      code: outcome.code,
      message: outcome.message,
    };
    results.push({ ok: false, ...failure });
    failures.push(failure);
  }

  return { ok: failures.length === 0, results, events, failures };
}
