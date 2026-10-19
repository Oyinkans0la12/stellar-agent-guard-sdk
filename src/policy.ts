import { Address, nativeToScVal, rpc, scValToNative, StrKey, xdr } from "@stellar/stellar-sdk";
/**
 * Guards against drift between this SDK and the deployed contract's types.
 *
 * A `#[contracttype]` struct crosses the host boundary as an `ScVal::Map` keyed
 * by field-name symbols, so these types are also the argument shape for
 * `set_policy`. `policyToScVal` builds exactly that, field by field, rather than
 * relying on a type-spec DSL — every cap keeps full i128 precision.
 *
 * Field names are exactly the contract's `PolicyConfig` / `ProtocolRule` /
 * `Status` field names as they appear in the Soroban spec
 * (`stellar-agent-guard-contracts/src/types.rs`), which is also how
 * `scValToNative` decodes them. Numeric fields stay `bigint` — the contract's
 * caps are `i128` and silently narrowing them to `number` would lose precision
 * on exactly the values a spend guard exists to compare.
 */
import { PolicyDecodeError } from "./errors.ts";
import { isGuardReason } from "./reasons.ts";
import type { ContractCall } from "./tx.ts";

/**
 * Branded types for address validation at compile time.
 * These use TypeScript's nominal typing (brand pattern) to distinguish
 * between contract addresses (C...), account addresses (G...), and raw
 * public key hex strings.
 */

/** A valid Stellar StrKey address (either G... or C...). */
export type StrKeyAddress = string & { readonly __brand: "StrKeyAddress" };

/** A valid Stellar contract address (C...). */
export type ContractAddress = string & { readonly __brand: "ContractAddress" };

/** A valid Stellar account address (G...). */
export type AccountAddress = string & { readonly __brand: "AccountAddress" };

/** A valid raw public key in hex format (64 characters). */
export type PublicKeyHex = string & { readonly __brand: "PublicKeyHex" };

/**
 * Type guards for branded address types.
 * These perform prefix and length validation according to Stellar StrKey format.
 */

/**
 * Check if a value is a valid Stellar StrKey address (either G... or C...).
 * @param value - The value to validate
 * @returns True if valid, false otherwise
 */
export function isStrKeyAddress(value: unknown): value is StrKeyAddress {
  if (typeof value !== "string") return false;
  if (value.length !== 56) return false;
  if (!value.match(/^[GC][A-Z2-7]{55}$/)) return false;
  // Use SDK's StrKey validation for both account (G) and contract (C) addresses
  return (
    (value.startsWith("G") && StrKey.isValidEd25519PublicKey(value)) ||
    (value.startsWith("C") && StrKey.isValidContract(value))
  );
}

/**
 * Check if a value is a valid Stellar contract address (C...).
 * Validates prefix, length (56 characters), and StrKey checksum format.
 * @param value - The value to validate
 * @returns True if valid, false otherwise
 */
export function isContractAddress(value: unknown): value is ContractAddress {
  if (typeof value !== "string") return false;
  if (!value.startsWith("C")) return false;
  if (value.length !== 56) return false;
  if (!value.match(/^C[A-Z2-7]{55}$/)) return false;
  return StrKey.isValidContract(value);
}

/**
 * Check if a value is a valid Stellar account address (G...).
 * Validates prefix, length (56 characters), and StrKey checksum format.
 * @param value - The value to validate
 * @returns True if valid, false otherwise
 */
export function isAccountAddress(value: unknown): value is AccountAddress {
  if (typeof value !== "string") return false;
  if (!value.startsWith("G")) return false;
  if (value.length !== 56) return false;
  if (!value.match(/^G[A-Z2-7]{55}$/)) return false;
  return StrKey.isValidEd25519PublicKey(value);
}

/**
 * Check if a value is a valid raw public key in hex format.
 * @param value - The value to validate
 * @returns True if valid (64 hex characters), false otherwise
 */
export function isPublicKeyHex(value: unknown): value is PublicKeyHex {
  if (typeof value !== "string") return false;
  if (value.length !== 64) return false;
  return /^[0-9a-fA-F]{64}$/.test(value);
}

/**
 * Unsafe cast helpers for test/fixture code.
 * Use only when you're certain the value is valid (e.g., hardcoded test addresses).
 * These bypass validation for convenience in tests.
 *
 * @internal For testing only
 */
export function unsafeContractAddress(value: string): ContractAddress {
  return value as ContractAddress;
}

export function unsafeAccountAddress(value: string): AccountAddress {
  return value as AccountAddress;
}

export function unsafeStrKeyAddress(value: string): StrKeyAddress {
  return value as StrKeyAddress;
}

export function unsafePublicKeyHex(value: string): PublicKeyHex {
  return value as PublicKeyHex;
}

export interface ProtocolRule {
  contract: ContractAddress;
  /** `null` means "any function on this contract". */
  fns: string[] | null;
}

export interface RecipientWindowCap {
  recipient: AccountAddress;
  cap: bigint;
}

export interface PolicyConfig {
  per_tx_cap: bigint;
  window_secs: bigint;
  window_cap: bigint;
  assets: ContractAddress[];
  protocols: ProtocolRule[];
  recipients: AccountAddress[];
  allow_any_recipient: boolean;
  active_from: bigint;
  active_until: bigint;
  paused: boolean;
  dms_grace_secs: bigint;
  recipient_window_caps?: RecipientWindowCap[];
  blocked_recipients?: AccountAddress[];
}

/** Recursively marks every property and array element as readonly. */
export type DeepReadonly<T> = T extends string | number | bigint | boolean | symbol | null | undefined
  ? T
  : T extends (infer U)[]
    ? ReadonlyArray<DeepReadonly<U>>
    : T extends object
      ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
      : T;

/** Immutable view of a PolicyConfig — the type all internal consumers use. */
export type ReadonlyPolicyConfig = DeepReadonly<PolicyConfig>;

/**
 * Freeze a policy object at the boundary so any later mutation throws in strict
 * mode (ESM modules are always strict) rather than silently producing a wrong
 * verdict. Cheap: one freeze per array, no copies.
 *
 * Call this once when a policy first enters the SDK — not on every read.
 */
export function freezePolicy(policy: PolicyConfig): ReadonlyPolicyConfig {
  for (const rule of policy.protocols) {
    if (rule.fns !== null) Object.freeze(rule.fns);
    Object.freeze(rule);
  }
  Object.freeze(policy.assets);
  Object.freeze(policy.protocols);
  Object.freeze(policy.recipients);
  if (policy.recipient_window_caps) {
    for (const cap of policy.recipient_window_caps) Object.freeze(cap);
    Object.freeze(policy.recipient_window_caps);
  }
  if (policy.blocked_recipients) Object.freeze(policy.blocked_recipients);
  return Object.freeze(policy) as ReadonlyPolicyConfig;
}

/**
 * SPEC §8 rule identifiers for granular policy validation failures.
 *
 * Hand-listed SPEC §8 rule IDs pending contract-level granular validation issue.
 * Swap-in point for contract-level vocabulary once available across repos.
 */
export const POLICY_RULE_IDS = [
  "invalid_type",
  "missing_field",
  "invalid_address",
  "negative_amount",
  "window_requires_secs",
  "recipient_cap_requires_window",
  "active_window_inverted",
  "empty_vector_noop",
  "duplicate_asset",
  "duplicate_recipient",
  "duplicate_blocked_recipient",
  "duplicate_protocol",
  "duplicate_protocol_function",
  "empty_protocol_functions",
  "duplicate_recipient_window_cap",
  "max_recipient_entries_exceeded",
  "recipient_conflict",
  "self_as_asset",
  "self_as_protocol",
  "self_as_recipient",
  "self_as_recipient_cap",
] as const;

export type PolicyRuleId = (typeof POLICY_RULE_IDS)[number];

export interface PolicyFailure {
  path: string;
  rule: PolicyRuleId;
  message: string;
}

export interface ValidatePolicyOptions {
  /** Guard contract address used to enforce self-address rejection rules. */
  guardAddress?: ContractAddress | string;
  /** Maximum allowed recipient entries (default: 256 per SPEC §8). */
  maxRecipientEntries?: number;
}

/** Type alias for PolicyConfig matching contract documentation and external vocabulary. */
export type GuardPolicy = PolicyConfig;

export interface GuardStatus {
  has_policy: boolean;
  admin_frozen: boolean;
  heartbeat_expired: boolean;
  last_heartbeat: bigint;
  now: bigint;
}

/**
 * `CheckResult` is a Rust enum over the wire; `scValToNative` decodes the unit
 * variant `Allowed` to the string `"Allowed"` and `Blocked(Symbol)` to an
 * object like `{ Blocked: "recipient_not_allowed" }`.
 *
 * `decodeCheckResult` is deliberately total: it never throws, so a hostile or
 * future contract payload cannot escape into the interceptor's verdict path.
 * Callers observe a typed fallback instead of an exception:
 *
 * - `Allowed` → `{ kind: "allowed" }`
 * - `Blocked(reason)` with a reason the contract defines →
 *   `{ kind: "blocked", reason }`
 * - anything else (unknown enum tag or reason, malformed shape, non-ScVal) →
 *   `{ kind: "undetermined" }` (fail-closed; the caller treats it as not-allowed)
 */
export type CheckResult =
  | { kind: "allowed" }
  | { kind: "blocked"; reason: string }
  | { kind: "undetermined" };

/**
 * Encode a `PolicyConfig` as the `ScVal::Map` the contract's `set_policy`
 * expects. Values are emitted as i128/u64/bool/Vec, matching the Rust struct
 * field types exactly.
 *
 * Keys MUST be sorted. The host converts an `ScVal::Map` into a typed struct by
 * walking entries in order, and rejects an unsorted map at conversion time:
 * `HostError: Error(Object, InvalidInput) — ScMap was not sorted by key for
 * conversion to host object`. Sorting by the symbol text is the same order the
 * host's `Symbol` comparison uses.
 */
export function policyToScVal(policy: ReadonlyPolicyConfig): xdr.ScVal {
  const entries: Array<{ key: string; val: xdr.ScVal }> = [
    { key: "per_tx_cap", val: nativeToScVal(policy.per_tx_cap, { type: "i128" }) },
    { key: "window_secs", val: nativeToScVal(policy.window_secs, { type: "u64" }) },
    { key: "window_cap", val: nativeToScVal(policy.window_cap, { type: "i128" }) },
    {
      key: "assets",
      val: xdr.ScVal.scvVec(policy.assets.map((asset) => new Address(asset).toScVal())),
    },
    {
      key: "protocols",
      val: xdr.ScVal.scvVec(
        policy.protocols.map((rule) =>
          sortedScMap([
            { key: "contract", val: new Address(rule.contract).toScVal() },
            {
              key: "fns",
              val:
                rule.fns === null
                  ? xdr.ScVal.scvVoid()
                  : xdr.ScVal.scvVec(rule.fns.map((fn) => xdr.ScVal.scvSymbol(fn))),
            },
          ]),
        ),
      ),
    },
    {
      key: "recipients",
      val: xdr.ScVal.scvVec(policy.recipients.map((address) => new Address(address).toScVal())),
    },
    { key: "allow_any_recipient", val: xdr.ScVal.scvBool(policy.allow_any_recipient) },
    { key: "active_from", val: nativeToScVal(policy.active_from, { type: "u64" }) },
    { key: "active_until", val: nativeToScVal(policy.active_until, { type: "u64" }) },
    { key: "paused", val: xdr.ScVal.scvBool(policy.paused) },
    { key: "dms_grace_secs", val: nativeToScVal(policy.dms_grace_secs, { type: "u64" }) },
  ];
  return sortedScMap(entries);
}

const POLICY_FIELDS = [
  "active_from",
  "active_until",
  "allow_any_recipient",
  "assets",
  "dms_grace_secs",
  "paused",
  "per_tx_cap",
  "protocols",
  "recipients",
  "window_cap",
  "window_secs",
] as const;
const PROTOCOL_RULE_FIELDS = ["contract", "fns"] as const;
const I128_MIN = -(2n ** 127n);
const I128_MAX = 2n ** 127n - 1n;
const U64_MAX = 2n ** 64n - 1n;

/**
 * Decode a `PolicyConfig` returned by the guard's `policy()` read, or the map
 * accepted by `set_policy`.
 *
 * This is the strict inverse of `policyToScVal`. Normalisation is deliberately
 * explicit because the same ScVal can reach callers through several SDK/RPC
 * surfaces:
 *
 * - a policy map is accepted directly; some RPC surfaces also wrap
 *   `Some(PolicyConfig)` in a one-element `Vec`, so that shape is accepted too;
 * - `fns: None` is `ScVal::Void` and becomes `null`, while
 *   `fns: Some(Vec<Symbol>)` becomes a string array;
 * - u64/i128 values become `bigint` without precision loss. Canonical XDR
 *   integers are decoded as integers; an `ScVal::String` containing a base-10
 *   integer is also accepted for stringly-typed RPC/telemetry payloads, then
 *   range-checked against u64/i128 bounds;
 * - address values must be `ScVal::Address` and are normalised to canonical
 *   Stellar strkeys; function names must be `ScVal::Symbol`.
 *
 * Maps must contain every expected field exactly once, no unknown fields, and
 * symbol keys in canonical ascending order. The decoder checks representation
 * and numeric bounds, but intentionally does not duplicate the contract's
 * cross-field policy validation: a `PolicyConfig` read back from the chain is
 * already valid, and local drafts should be validated before encoding.
 *
 * A missing policy (`Void`) is not a `PolicyConfig`; it throws a typed
 * `PolicyDecodeError` rather than inventing a default-deny policy value.
 */
export function decodePolicy(scVal: xdr.ScVal): PolicyConfig {
  try {
    const fields = symbolMap(policyMap(scVal), "policy", POLICY_FIELDS);
    return {
      per_tx_cap: policyInteger(
        fields.get("per_tx_cap")!,
        "per_tx_cap",
        "i128",
        I128_MIN,
        I128_MAX,
      ),
      window_secs: policyInteger(fields.get("window_secs")!, "window_secs", "u64", 0n, U64_MAX),
      window_cap: policyInteger(
        fields.get("window_cap")!,
        "window_cap",
        "i128",
        I128_MIN,
        I128_MAX,
      ),
      assets: addressVector(fields.get("assets")!, "assets").map(a => a as ContractAddress),
      protocols: protocolRules(fields.get("protocols")!),
      recipients: addressVector(fields.get("recipients")!, "recipients").map(a => a as AccountAddress),
      allow_any_recipient: policyBoolean(
        fields.get("allow_any_recipient")!,
        "allow_any_recipient",
      ),
      active_from: policyInteger(fields.get("active_from")!, "active_from", "u64", 0n, U64_MAX),
      active_until: policyInteger(fields.get("active_until")!, "active_until", "u64", 0n, U64_MAX),
      paused: policyBoolean(fields.get("paused")!, "paused"),
      dms_grace_secs: policyInteger(
        fields.get("dms_grace_secs")!,
        "dms_grace_secs",
        "u64",
        0n,
        U64_MAX,
      ),
    };
  } catch (error) {
    if (error instanceof PolicyDecodeError) throw error;
    throw policyDecodeFailure("policy", "could not decode ScVal", error);
  }
}

/** Alias matching the issue terminology; `decodePolicy` is the canonical name. */
export function policyFromScVal(scVal: xdr.ScVal): PolicyConfig {
  return decodePolicy(scVal);
}

function policyMap(scVal: xdr.ScVal): xdr.ScVal {
  if (scVal.type === "scvMap") return scVal;
  if (scVal.type === "scvVec") {
    const values = (scVal as unknown as { vec?: xdr.ScVal[] }).vec ?? [];
    if (values.length === 1 && values[0]?.type === "scvMap") return values[0];
    throw policyDecodeFailure(
      "policy",
      `expected a policy map or a one-element Some(policy) vector, got ${values.length} vector item(s)`,
    );
  }
  if (scVal.type === "scvVoid") {
    throw policyDecodeFailure("policy", "no policy is installed (Void is None, not a config)");
  }
  throw policyDecodeFailure("policy", `expected a map, got ${scVal.type}`);
}

function symbolMap(
  scVal: xdr.ScVal,
  path: string,
  expectedFields: readonly string[],
): Map<string, xdr.ScVal> {
  if (scVal.type !== "scvMap") throw policyDecodeFailure(path, `expected a map, got ${scVal.type}`);

  const entries = (scVal as unknown as { map?: xdr.ScMapEntry[] }).map ?? [];
  const fields = new Map<string, xdr.ScVal>();
  let previous: string | null = null;

  for (const entry of entries) {
    if (entry.key.type !== "scvSymbol") {
      throw policyDecodeFailure(`${path}.<key>`, `expected a symbol key, got ${entry.key.type}`);
    }
    const name = String(scValToNative(entry.key));
    if (fields.has(name)) throw policyDecodeFailure(path, `duplicate field ${JSON.stringify(name)}`);
    if (previous !== null && name <= previous) {
      throw policyDecodeFailure(path, `symbol keys are not sorted (${previous} precedes ${name})`);
    }
    if (!expectedFields.includes(name)) {
      throw policyDecodeFailure(path, `unknown field ${JSON.stringify(name)}`);
    }
    fields.set(name, entry.val);
    previous = name;
  }

  const missing = expectedFields.filter((name) => !fields.has(name));
  if (missing.length > 0) throw policyDecodeFailure(path, `missing field(s): ${missing.join(", ")}`);
  return fields;
}

function policyInteger(
  scVal: xdr.ScVal,
  path: string,
  wireType: "u64" | "i128",
  min: bigint,
  max: bigint,
): bigint {
  const expectedType = wireType === "u64" ? "scvU64" : "scvI128";
  if (scVal.type !== expectedType && scVal.type !== "scvString") {
    throw policyDecodeFailure(
      path,
      `expected ${wireType} (${expectedType}), or a decimal string, got ${scVal.type}`,
    );
  }

  const native = scValToNative(scVal);
  let value: bigint;
  if (typeof native === "bigint") {
    value = native;
  } else if (typeof native === "number") {
    if (!Number.isSafeInteger(native)) {
      throw policyDecodeFailure(path, `number ${native} cannot be represented safely`);
    }
    value = BigInt(native);
  } else if (typeof native === "string" && /^[+-]?\d+$/.test(native)) {
    value = BigInt(native);
  } else {
    throw policyDecodeFailure(path, "value is not a base-10 integer");
  }

  if (value < min || value > max) {
    throw policyDecodeFailure(path, `${value} is outside the supported [${min}, ${max}] range`);
  }
  return value;
}

function policyBoolean(scVal: xdr.ScVal, path: string): boolean {
  if (scVal.type !== "scvBool") {
    throw policyDecodeFailure(path, `expected bool, got ${scVal.type}`);
  }
  const value = scValToNative(scVal);
  if (typeof value !== "boolean") throw policyDecodeFailure(path, "value did not decode to bool");
  return value;
}

function policyVec(scVal: xdr.ScVal, path: string): xdr.ScVal[] {
  if (scVal.type !== "scvVec") {
    throw policyDecodeFailure(path, `expected Vec, got ${scVal.type}`);
  }
  return (scVal as unknown as { vec?: xdr.ScVal[] }).vec ?? [];
}

function policyAddress(scVal: xdr.ScVal, path: string): string {
  if (scVal.type !== "scvAddress") {
    throw policyDecodeFailure(path, `expected Address, got ${scVal.type}`);
  }
  try {
    const address = new Address(scValToNative(scVal) as string);
    return address.toString();
  } catch (error) {
    throw policyDecodeFailure(path, "value is not a valid Stellar address", error);
  }
}

function addressVector(scVal: xdr.ScVal, path: string): string[] {
  const addresses = policyVec(scVal, path).map((item, index) => policyAddress(item, `${path}[${index}]`));
  // Cast each address based on context - caller is responsible for semantics
  // For decodePolicy, the caller will know whether it's assets (ContractAddress) 
  // or recipients (AccountAddress)
  return addresses;
}

function protocolRules(scVal: xdr.ScVal): ProtocolRule[] {
  return policyVec(scVal, "protocols").map((rule, index) => {
    const path = `protocols[${index}]`;
    const fields = symbolMap(rule, path, PROTOCOL_RULE_FIELDS);
    const contractAddr = policyAddress(fields.get("contract")!, `${path}.contract`);
    return {
      contract: contractAddr as ContractAddress,
      fns: functionSymbols(fields.get("fns")!, `${path}.fns`),
    };
  });
}

function functionSymbols(scVal: xdr.ScVal, path: string): string[] | null {
  if (scVal.type === "scvVoid") return null;
  return policyVec(scVal, path).map((item, index) => {
    if (item.type !== "scvSymbol") {
      throw policyDecodeFailure(`${path}[${index}]`, `expected Symbol, got ${item.type}`);
    }
    return String(scValToNative(item));
  });
}

function policyDecodeFailure(path: string, detail: string, cause?: unknown): PolicyDecodeError {
  return new PolicyDecodeError(`cannot decode policy field ${path}: ${detail}`, {
    path,
    ...(cause === undefined ? {} : { cause }),
  });
}

/**
 * Build an `ScVal::Map` with symbol keys in ascending order, as the host
 * requires for struct conversion. Comparison is by code unit, which for the
 * ASCII field names used by the contract is byte order.
 */
function sortedScMap(entries: Array<{ key: string; val: xdr.ScVal }>): xdr.ScVal {
  const sorted = [...entries].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return xdr.ScVal.scvMap(
    sorted.map(
      (item) =>
        new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol(item.key), val: item.val }),
    ),
  );
}

/**
 * Decode the guard's `CheckResult` into a typed verdict.
 *
 * Accepts either the raw `xdr.ScVal` the contract returns (for example
 * `simulation.returnValue`) or the native value `scValToNative` produces from it,
 * so a caller never has to decode twice. On the wire a `#[contracttype]` enum is
 * a `ScVec` whose first element is the variant name — `["Allowed"]` or
 * `["Blocked", "recipient_not_allowed"]` — which `scValToNative` turns into
 * `"Allowed"` and `["Blocked", reason]` respectively. The symbol-only and
 * `{ Blocked: reason }` native forms are accepted too.
 *
 * Deliberately total: it never throws, so a hostile or future payload cannot
 * escape into the interceptor's verdict path.
 */
export function decodeCheckResult(raw: unknown): CheckResult {
  try {
    const native = raw instanceof xdr.ScVal ? nativeCheckResult(raw as xdr.ScVal) : raw;

    if (native === "Allowed") return { kind: "allowed" };

    if (Array.isArray(native)) {
      if (native.length === 1 && native[0] === "Allowed") return { kind: "allowed" };
      if (native.length === 2 && native[0] === "Blocked" && typeof native[1] === "string") {
        return blockedCheckResult(native[1]);
      }
      return { kind: "undetermined" };
    }

    if (native && typeof native === "object" && "Blocked" in (native as Record<string, unknown>)) {
      const reason = (native as { Blocked: unknown }).Blocked;
      if (typeof reason === "string") return blockedCheckResult(reason);
    }
  } catch {
    // fall through to the fail-closed verdict below
  }
  // Unknown enum tag, malformed shape, or non-ScVal input: fail closed rather
  // than throwing into the interceptor's verdict path.
  return { kind: "undetermined" };
}

/**
 * Unwrap the two ScVal shapes a `#[contracttype]` enum can take, so the caller's
 * fallback applies to every other ScVal type instead of an arbitrary ScVal's
 * native value being mistaken for a verdict.
 */
function nativeCheckResult(scVal: xdr.ScVal): unknown {
  if (scVal.type !== "scvVec" && scVal.type !== "scvSymbol") return null;
  return scValToNative(scVal);
}

/**
 * A `Blocked` payload decodes only for a reason the contract actually defines.
 * An unrecognised reason is a future or hostile payload, so it fails closed to
 * `undetermined` rather than being surfaced as a refusal reason callers would
 * then try to map.
 */
function blockedCheckResult(reason: string): CheckResult {
  return isGuardReason(reason) ? { kind: "blocked", reason } : { kind: "undetermined" };
}

/**
 * True when the dead-man switch has fired: frozen by silence, not by an admin.
 *
 * Semantics are pinned to the contract's own truth (SPEC §5, the Dead-Man
 * Switch section of `stellar-agent-guard-contracts/SPEC.md`): the freeze is
 * derived lazily from `LastHeartbeat` and ledger time on every authorization,
 * and rule #2 of that derivation **requires `LastHeartbeat != 0`** — a value
 * of `0` means "never heartbeated" (the storage key's own documented default:
 * "unix seconds of last agent heartbeat (0 = never)"), and a never-heartbeated
 * account is not frozen *by the dead-man switch*. It is spendable if otherwise
 * allowed. "Never" is therefore not "expired": treating `0` as epoch-0 would
 * report a healthy fresh account as frozen since 1970, which is exactly the
 * dashboard false alarm this guard exists to prevent.
 *
 * The check below is defensive rather than trustful: if a decoded `Status`
 * ever carried `heartbeat_expired = true` alongside `last_heartbeat = 0` (a
 * contract build that predates rule #2, or a hand-assembled status), this
 * helper still reports not-dead-man-frozen, matching what the contract could
 * truthfully enforce. An admin freeze is reported separately via
 * `admin_frozen`, exactly as the contract treats the two conditions as
 * separate (see SPEC §5, "Manual freeze" and "Reversal path").
 */
export function isDeadManFrozen(status: GuardStatus): boolean {
  if (status.last_heartbeat === 0n) return false; // never ≠ expired (SPEC §5 rule #2)
  return status.heartbeat_expired && !status.admin_frozen;
}

/**
 * Seconds of grace remaining before the dead-man switch fires. `null` when the
 * switch is disabled (`dms_grace_secs == 0`), a positive number while the agent
 * is still within grace, and a negative number once the account is frozen.
 *
 * `null` also covers the never-heartbeated case: `last_heartbeat == 0` means
 * "no heartbeat has ever been recorded" (the storage key's documented default,
 * SPEC §3 — `0 = never`), so no grace countdown has started and there is no
 * remaining time to report. Per SPEC §5 rule #2 a never-heartbeated account is
 * **not** dead-man-frozen — "never ≠ expired" — it is spendable if otherwise
 * allowed, and `null` here must never be read as "overdue". Callers that want
 * a full-grace rendering for a fresh account can treat `null` (with a non-zero
 * grace and `last_heartbeat == 0`) as "countdown not yet started".
 */
export function deadManRemaining(status: GuardStatus, policy: ReadonlyPolicyConfig | null): bigint | null {
  if (!policy || policy.dms_grace_secs === 0n || status.last_heartbeat === 0n) return null;
  return status.last_heartbeat + policy.dms_grace_secs - status.now;
}

/**
 * Where a policy's active window stands at a given moment.
 *
 * - `unbounded` — no window at all: `active_from` and `active_until` are both 0.
 * - `scheduled` — the window has not opened yet (`now < active_from`).
 * - `active` — the window is open.
 * - `expired` — the window closed (`active_until` is set and `now >= active_until`).
 */
export type ActiveWindowState = "unbounded" | "scheduled" | "active" | "expired";

/**
 * Options for `describePolicy`.
 */
export interface DescribePolicyOptions {
  /**
   * Include the full recipient lists — the allowlist, the blocked recipients
   * and the per-recipient window caps — instead of their counts.
   *
   * Off by default: a summary is a log line, and a policy can name hundreds of
   * recipients. The counts are what an operator scans for; the lists are what
   * an operator needs once the count itself is the surprise.
   */
  detail?: boolean;
  /**
   * The moment the active window is judged against, in unix seconds.
   *
   * Defaults to the current time. Pass it to make the summary reproducible —
   * a dashboard snapshot, a test, a diff between two reports.
   */
  nowSecs?: number | bigint;
}

/**
 * The active-window state of a policy at `nowSecs`.
 *
 * `0` means "unset" on both bounds, exactly as the contract reads it: an
 * `active_from` of 0 does not start the policy at the epoch, it means the
 * policy was never restricted, and an `active_until` of 0 means the policy
 * never expires.
 */
function activeWindowState(
  activeFrom: bigint,
  activeUntil: bigint,
  nowSecs: bigint,
): ActiveWindowState {
  if (activeFrom === 0n && activeUntil === 0n) return "unbounded";
  if (activeFrom > nowSecs) return "scheduled";
  if (activeUntil > 0n && nowSecs >= activeUntil) return "expired";
  return "active";
}

/**
 * A unix-seconds boundary, as an ISO timestamp when it fits one.
 *
 * A policy is not required to carry a timestamp a `Date` can represent, and
 * `toISOString()` throws on an out-of-range instant — so an unrepresentable
 * boundary is rendered as the raw seconds instead of taking the whole summary
 * down with it.
 */
function formatUnixSeconds(seconds: bigint): string {
  const millis = Number(seconds) * 1000;
  if (!Number.isFinite(millis) || Math.abs(millis) > 8.64e15) return `${seconds}s`;
  return new Date(millis).toISOString();
}

/**
 * The active window of a policy, as one clause: its bounds and its state.
 *
 * The bounds are always reported; the state says whether the policy is
 * enforceable *right now*, which is the part an operator cannot read off the
 * numbers alone.
 */
function describeActiveWindow(
  activeFrom: bigint,
  activeUntil: bigint,
  nowSecs: bigint,
): string {
  const state = activeWindowState(activeFrom, activeUntil, nowSecs);
  if (state === "unbounded") return "no active window";
  const from = activeFrom === 0n ? "always" : formatUnixSeconds(activeFrom);
  const until = activeUntil === 0n ? "never" : formatUnixSeconds(activeUntil);
  return `active window ${from} -> ${until} (${state})`;
}

/**
 * The recipient-specific constraints of a policy, as summary clauses.
 *
 * Both lists are optional on the policy: an absent list and an empty list
 * mean the same thing — the constraint is not in force — so neither produces a
 * clause. A policy that carries one is reported, because a summary that calls
 * a policy with a blocklist "broadly permissive" is worse than no summary at
 * all.
 */
function describeRecipientConstraints(
  policy: ReadonlyPolicyConfig,
  detail: boolean,
): string[] {
  const parts: string[] = [];
  const blocked = policy.blocked_recipients ?? [];
  if (blocked.length > 0) {
    parts.push(
      detail
        ? `blocked recipients: ${[...blocked].sort().join(", ")}`
        : `${blocked.length} blocked recipient(s)`,
    );
  }
  const caps = policy.recipient_window_caps ?? [];
  if (caps.length > 0) {
    parts.push(
      detail
        ? `per-recipient window caps: ${[...caps]
            .sort((a, b) => compareRecipientCaps(a, b))
            .map((cap) => `${cap.recipient} -> ${cap.cap}`)
            .join(", ")}`
        : `${caps.length} per-recipient window cap(s)`,
    );
  }
  return parts;
}

/** Order two per-recipient caps by recipient, then by cap — a stable order. */
function compareRecipientCaps(
  a: Readonly<RecipientWindowCap>,
  b: Readonly<RecipientWindowCap>,
): number {
  if (a.recipient !== b.recipient) return a.recipient < b.recipient ? -1 : 1;
  if (a.cap === b.cap) return 0;
  return a.cap < b.cap ? -1 : 1;
}

/**
 * The moment the active window is judged against, in whole unix seconds.
 */
function describeNowSecs(value: number | bigint | undefined): bigint {
  if (value === undefined) return BigInt(Math.floor(Date.now() / 1000));
  if (typeof value === "bigint") return value;
  if (!Number.isFinite(value)) {
    throw new RangeError(`describePolicy nowSecs must be a finite number, received ${value}`);
  }
  return BigInt(Math.floor(value));
}

/**
 * A compact, log-friendly rendering of the policy in force.
 *
 * The summary is **complete**: it names the constraints that materially change
 * which transfers are allowed — the per-recipient window caps, the blocked
 * recipients, and the active window with its state — so a reader never has to
 * open the policy to learn that it is narrower than the first line suggests.
 *
 * It is also **quiet by default**: recipient lists are reported as counts, and
 * `detail: true` is the explicit way to ask for the addresses themselves. The
 * recipient lists are sorted, so the same policy always renders the same way.
 */
export function describePolicy(
  policy: ReadonlyPolicyConfig | null,
  options?: DescribePolicyOptions,
): string {
  if (!policy) return "no policy installed (default-deny: every action is blocked)";
  const detail = options?.detail === true;
  const nowSecs = describeNowSecs(options?.nowSecs);
  const parts = [
    `per-tx cap ${policy.per_tx_cap}`,
    `rolling window ${policy.window_cap} / ${policy.window_secs}s`,
    `${policy.assets.length} asset(s)`,
    policy.allow_any_recipient
      ? "any recipient"
      : detail
        ? `allowlisted recipients: ${[...policy.recipients].sort().join(", ")}`
        : `${policy.recipients.length} allowlisted recipient(s)`,
    `${policy.protocols.length} allowlisted protocol(s)`,
    policy.paused ? "PAUSED" : "active",
    policy.dms_grace_secs > 0n ? `dead-man grace ${policy.dms_grace_secs}s` : "dead-man switch off",
    ...describeRecipientConstraints(policy, detail),
    describeActiveWindow(policy.active_from, policy.active_until, nowSecs),
  ];
  return parts.join(", ");
}

/**
 * Extract the token transfer amount from a SAC contract call.
 *
 * Full recipient/amount enforcement is native to SAC token transfers (`transfer`
 * and `transfer_from`). For `transfer(from, to, amount)`, the amount is the 3rd
 * argument (index 2). For `transfer_from(spender, from, to, amount)`, the amount
 * is the 4th argument (index 3).
 *
 * Returns null if the call is not a recognized SAC transfer or if the amount
 * argument cannot be decoded into a BigInt.
 */
export function extractTransferAmount(call: ContractCall): bigint | null {
  const arg =
    call.fn === "transfer" ? call.args?.[2] : call.fn === "transfer_from" ? call.args?.[3] : undefined;
  if (arg === undefined) return null;
  if (typeof arg === "bigint") return arg;
  if (typeof arg === "number") return BigInt(arg);
  try {
    const native = scValToNative(arg);
    return typeof native === "bigint" ? native : BigInt(native as number | string);
  } catch {
    return null;
  }
}

/**
 * Read one of a contract's persistent storage entries from ledger state via RPC.
 */
export async function readPersistentEntry(
  server: rpc.Server,
  contractId: string,
  dataKeyName: string,
): Promise<{ value: unknown; lastModifiedLedgerSeq: number | null } | null> {
  const key = xdr.LedgerKey.contractData(
    new xdr.LedgerKeyContractData({
      contract: new Address(contractId).toScAddress(),
      key: xdr.ScVal.scvVec([xdr.ScVal.scvSymbol(dataKeyName)]),
      durability: xdr.ContractDataDurability.persistent,
    }),
  );
  const response = await server.getLedgerEntries(key);
  const entry = response.entries?.[0] as unknown as {
    val?: { contractData?: () => { val?: () => xdr.ScVal } | { val?: xdr.ScVal } } | { contractData?: { val?: xdr.ScVal } };
    lastModifiedLedgerSeq?: number;
  };
  let scval: xdr.ScVal | undefined;
  if (entry?.val) {
    const contractData =
      typeof (entry.val as { contractData?: unknown }).contractData === "function"
        ? (entry.val as { contractData: () => { val?: unknown } }).contractData()
        : (entry.val as { contractData?: { val?: unknown } }).contractData;
    if (contractData) {
      scval =
        typeof contractData.val === "function"
          ? (contractData.val() as xdr.ScVal)
          : (contractData.val as xdr.ScVal);
    }
  }
  if (!scval) return null;
  return {
    value: scValToNative(scval) as unknown,
    lastModifiedLedgerSeq: entry.lastModifiedLedgerSeq ?? null,
  };
}

/**
 * Read the live policy and committed window spent from ledger state via RPC.
 */
export async function fetchGuardPolicyAndWindow(
  server: rpc.Server,
  guard: string,
): Promise<{ policy: PolicyConfig | null; windowSpent: bigint }> {
  const [policyEntry, windowEntry] = await Promise.all([
    readPersistentEntry(server, guard, "Policy"),
    readPersistentEntry(server, guard, "Window"),
  ]);

  let policy: PolicyConfig | null = null;
  if (policyEntry?.value && typeof policyEntry.value === "object") {
    policy = policyEntry.value as PolicyConfig;
  }

  let windowSpent = 0n;
  if (windowEntry?.value && typeof windowEntry.value === "object") {
    const windowObj = windowEntry.value as { total?: bigint | number };
    windowSpent = BigInt(windowObj.total ?? 0);
  }

  return { policy, windowSpent };
}

function isValidStellarAddress(addr: unknown): addr is string {
  if (typeof addr !== "string") return false;
  try {
    new Address(addr);
    return true;
  } catch {
    return false;
  }
}

function normalizeStellarAddress(addr: string): string | null {
  try {
    return new Address(addr).toString();
  } catch {
    return null;
  }
}

function isIntegerLike(val: unknown): boolean {
  if (typeof val === "bigint") return true;
  if (typeof val === "number") return Number.isSafeInteger(val);
  if (typeof val === "string" && /^[+-]?\d+$/.test(val.trim())) return true;
  return false;
}

function toBigInt(val: unknown): bigint {
  if (typeof val === "bigint") return val;
  if (typeof val === "number") return BigInt(val);
  if (typeof val === "string") return BigInt(val.trim());
  return 0n;
}

/**
 * Validate a candidate guard policy against SPEC §8 rules before encoding or broadcast.
 *
 * Catches configuration errors client-side and returns all granular PolicyFailure
 * items at once to support complete UI form validation and pre-broadcast gates.
 *
 * @param policy Candidate policy object (parsed JSON, draft, or PolicyConfig).
 * @param optionsOrGuardAddress Optional validation options or guard contract ID.
 * @returns An array of PolicyFailure objects, empty if the policy is valid.
 */
export function validateGuardPolicy(
  policy: unknown,
  optionsOrGuardAddress?: ValidatePolicyOptions | string,
): PolicyFailure[] {
  const options: ValidatePolicyOptions =
    typeof optionsOrGuardAddress === "string"
      ? { guardAddress: optionsOrGuardAddress }
      : optionsOrGuardAddress ?? {};

  if (policy === null || typeof policy !== "object" || Array.isArray(policy)) {
    return [
      {
        path: "policy",
        rule: "invalid_type",
        message: "policy must be a non-null object",
      },
    ];
  }

  const raw = policy as Record<string, unknown>;
  const failures: PolicyFailure[] = [];
  const maxRecipientEntries = options.maxRecipientEntries ?? 256;
  const guardAddress = options.guardAddress ? normalizeStellarAddress(options.guardAddress) : null;

  // 1. per_tx_cap (SPEC §8 bullet 1)
  if (raw.per_tx_cap === undefined || raw.per_tx_cap === null) {
    failures.push({
      path: "per_tx_cap",
      rule: "missing_field",
      message: "per_tx_cap is required",
    });
  } else if (!isIntegerLike(raw.per_tx_cap)) {
    failures.push({
      path: "per_tx_cap",
      rule: "invalid_type",
      message: "per_tx_cap must be an integer or bigint",
    });
  } else if (toBigInt(raw.per_tx_cap) < 0n) {
    failures.push({
      path: "per_tx_cap",
      rule: "negative_amount",
      message: "per_tx_cap must be non-negative (>= 0)",
    });
  }

  // 2. window_secs (SPEC §8 bullet 1)
  let windowSecs: bigint | null = null;
  if (raw.window_secs === undefined || raw.window_secs === null) {
    failures.push({
      path: "window_secs",
      rule: "missing_field",
      message: "window_secs is required",
    });
  } else if (!isIntegerLike(raw.window_secs)) {
    failures.push({
      path: "window_secs",
      rule: "invalid_type",
      message: "window_secs must be an integer or bigint",
    });
  } else {
    windowSecs = toBigInt(raw.window_secs);
    if (windowSecs < 0n) {
      failures.push({
        path: "window_secs",
        rule: "negative_amount",
        message: "window_secs must be non-negative (>= 0)",
      });
    }
  }

  // 3. window_cap (SPEC §8 bullet 1 & 2)
  if (raw.window_cap === undefined || raw.window_cap === null) {
    failures.push({
      path: "window_cap",
      rule: "missing_field",
      message: "window_cap is required",
    });
  } else if (!isIntegerLike(raw.window_cap)) {
    failures.push({
      path: "window_cap",
      rule: "invalid_type",
      message: "window_cap must be an integer or bigint",
    });
  } else {
    const windowCap = toBigInt(raw.window_cap);
    if (windowCap < 0n) {
      failures.push({
        path: "window_cap",
        rule: "negative_amount",
        message: "window_cap must be non-negative (>= 0)",
      });
    }
    // SPEC §8 bullet 2: window_cap != 0 requires window_secs != 0
    if (windowCap > 0n && windowSecs !== null && windowSecs === 0n) {
      failures.push({
        path: "window_cap",
        rule: "window_requires_secs",
        message: "window_cap > 0 requires window_secs != 0",
      });
    }
  }

  // 4. assets (SPEC §8 bullet 5, 6, 10)
  if (!Array.isArray(raw.assets)) {
    failures.push({
      path: "assets",
      rule: "invalid_type",
      message: "assets must be an array of Stellar contract addresses",
    });
  } else {
    if (raw.assets.length === 0) {
      failures.push({
        path: "assets",
        rule: "empty_vector_noop",
        message: "assets list is empty; SAC token transfers will never be allowed",
      });
    }
    const seenAssets = new Set<string>();
    for (let i = 0; i < raw.assets.length; i++) {
      const a = raw.assets[i];
      if (!isValidStellarAddress(a)) {
        failures.push({
          path: `assets[${i}]`,
          rule: "invalid_address",
          message: `"${a}" is not a valid Stellar address`,
        });
        continue;
      }
      const norm = normalizeStellarAddress(a)!;
      if (seenAssets.has(norm)) {
        failures.push({
          path: `assets[${i}]`,
          rule: "duplicate_asset",
          message: `duplicate asset address "${a}"`,
        });
      }
      seenAssets.add(norm);
      if (guardAddress && norm === guardAddress) {
        failures.push({
          path: `assets[${i}]`,
          rule: "self_as_asset",
          message: "guard contract address cannot be listed as an asset",
        });
      }
    }
  }

  // 5. protocols (SPEC §8 bullet 5, 6, 10)
  if (!Array.isArray(raw.protocols)) {
    failures.push({
      path: "protocols",
      rule: "invalid_type",
      message: "protocols must be an array of ProtocolRule",
    });
  } else {
    const seenProtocols = new Set<string>();
    for (let i = 0; i < raw.protocols.length; i++) {
      const p = raw.protocols[i];
      if (!p || typeof p !== "object" || Array.isArray(p)) {
        failures.push({
          path: `protocols[${i}]`,
          rule: "invalid_type",
          message: "protocol rule must be an object",
        });
        continue;
      }
      const ruleObj = p as Record<string, unknown>;
      if (!isValidStellarAddress(ruleObj.contract)) {
        failures.push({
          path: `protocols[${i}].contract`,
          rule: "invalid_address",
          message: `"${ruleObj.contract}" is not a valid Stellar address`,
        });
      } else {
        const norm = normalizeStellarAddress(ruleObj.contract)!;
        if (seenProtocols.has(norm)) {
          failures.push({
            path: `protocols[${i}].contract`,
            rule: "duplicate_protocol",
            message: `duplicate protocol contract "${ruleObj.contract}"`,
          });
        }
        seenProtocols.add(norm);
        if (guardAddress && norm === guardAddress) {
          failures.push({
            path: `protocols[${i}].contract`,
            rule: "self_as_protocol",
            message: "guard contract address cannot be listed as a protocol",
          });
        }
      }

      if (ruleObj.fns !== null && ruleObj.fns !== undefined) {
        if (!Array.isArray(ruleObj.fns)) {
          failures.push({
            path: `protocols[${i}].fns`,
            rule: "invalid_type",
            message: "protocol fns must be null or an array of function name strings",
          });
        } else if (ruleObj.fns.length === 0) {
          failures.push({
            path: `protocols[${i}].fns`,
            rule: "empty_protocol_functions",
            message: "protocol fns list must not be empty (use null to allow any function)",
          });
        } else {
          const seenFns = new Set<string>();
          for (let j = 0; j < ruleObj.fns.length; j++) {
            const fn = ruleObj.fns[j];
            if (typeof fn !== "string" || fn.length === 0) {
              failures.push({
                path: `protocols[${i}].fns[${j}]`,
                rule: "invalid_type",
                message: "protocol function name must be a non-empty string",
              });
              continue;
            }
            if (seenFns.has(fn)) {
              failures.push({
                path: `protocols[${i}].fns[${j}]`,
                rule: "duplicate_protocol_function",
                message: `duplicate function "${fn}" in protocol rule`,
              });
            }
            seenFns.add(fn);
          }
        }
      }
    }
  }

  // 6. allow_any_recipient (type check)
  if (typeof raw.allow_any_recipient !== "boolean") {
    failures.push({
      path: "allow_any_recipient",
      rule: "invalid_type",
      message: "allow_any_recipient must be a boolean",
    });
  }

  // 7. recipients (SPEC §8 bullet 5, 6, 8, 10)
  const seenRecipients = new Set<string>();
  if (!Array.isArray(raw.recipients)) {
    failures.push({
      path: "recipients",
      rule: "invalid_type",
      message: "recipients must be an array of Stellar addresses",
    });
  } else {
    if (raw.recipients.length === 0 && raw.allow_any_recipient === false) {
      failures.push({
        path: "recipients",
        rule: "empty_vector_noop",
        message: "recipients list is empty while allow_any_recipient is false; no recipient will be allowed",
      });
    }
    if (raw.recipients.length > maxRecipientEntries) {
      failures.push({
        path: "recipients",
        rule: "max_recipient_entries_exceeded",
        message: `recipients list exceeds maximum of ${maxRecipientEntries} entries (${raw.recipients.length})`,
      });
    }
    for (let i = 0; i < raw.recipients.length; i++) {
      const r = raw.recipients[i];
      if (!isValidStellarAddress(r)) {
        failures.push({
          path: `recipients[${i}]`,
          rule: "invalid_address",
          message: `"${r}" is not a valid Stellar address`,
        });
        continue;
      }
      const norm = normalizeStellarAddress(r)!;
      if (seenRecipients.has(norm)) {
        failures.push({
          path: `recipients[${i}]`,
          rule: "duplicate_recipient",
          message: `duplicate recipient address "${r}"`,
        });
      }
      seenRecipients.add(norm);
      if (guardAddress && norm === guardAddress) {
        failures.push({
          path: `recipients[${i}]`,
          rule: "self_as_recipient",
          message: "guard contract address cannot be listed as a recipient",
        });
      }
    }
  }

  // 8. blocked_recipients (SPEC §8 bullet 6, 8, 9, 10)
  if (raw.blocked_recipients !== undefined && raw.blocked_recipients !== null) {
    if (!Array.isArray(raw.blocked_recipients)) {
      failures.push({
        path: "blocked_recipients",
        rule: "invalid_type",
        message: "blocked_recipients must be an array of Stellar addresses",
      });
    } else {
      if (raw.blocked_recipients.length > maxRecipientEntries) {
        failures.push({
          path: "blocked_recipients",
          rule: "max_recipient_entries_exceeded",
          message: `blocked_recipients list exceeds maximum of ${maxRecipientEntries} entries (${raw.blocked_recipients.length})`,
        });
      }
      const seenBlocked = new Set<string>();
      for (let i = 0; i < raw.blocked_recipients.length; i++) {
        const b = raw.blocked_recipients[i];
        if (!isValidStellarAddress(b)) {
          failures.push({
            path: `blocked_recipients[${i}]`,
            rule: "invalid_address",
            message: `"${b}" is not a valid Stellar address`,
          });
          continue;
        }
        const norm = normalizeStellarAddress(b)!;
        if (seenBlocked.has(norm)) {
          failures.push({
            path: `blocked_recipients[${i}]`,
            rule: "duplicate_blocked_recipient",
            message: `duplicate blocked recipient address "${b}"`,
          });
        }
        seenBlocked.add(norm);
        if (guardAddress && norm === guardAddress) {
          failures.push({
            path: `blocked_recipients[${i}]`,
            rule: "self_as_recipient",
            message: "guard contract address cannot be listed as a blocked recipient",
          });
        }
        // SPEC §8 bullet 9: recipients and blocked_recipients must not intersect
        if (seenRecipients.has(norm)) {
          failures.push({
            path: `blocked_recipients[${i}]`,
            rule: "recipient_conflict",
            message: `recipient "${b}" appears in both recipients and blocked_recipients`,
          });
        }
      }
    }
  }

  // 9. recipient_window_caps (SPEC §8 bullet 1, 3, 7, 8, 10)
  if (raw.recipient_window_caps !== undefined && raw.recipient_window_caps !== null) {
    if (!Array.isArray(raw.recipient_window_caps)) {
      failures.push({
        path: "recipient_window_caps",
        rule: "invalid_type",
        message: "recipient_window_caps must be an array of RecipientWindowCap objects",
      });
    } else {
      if (raw.recipient_window_caps.length > maxRecipientEntries) {
        failures.push({
          path: "recipient_window_caps",
          rule: "max_recipient_entries_exceeded",
          message: `recipient_window_caps list exceeds maximum of ${maxRecipientEntries} entries (${raw.recipient_window_caps.length})`,
        });
      }
      const seenCapRecipients = new Set<string>();
      for (let i = 0; i < raw.recipient_window_caps.length; i++) {
        const rc = raw.recipient_window_caps[i];
        if (!rc || typeof rc !== "object" || Array.isArray(rc)) {
          failures.push({
            path: `recipient_window_caps[${i}]`,
            rule: "invalid_type",
            message: "recipient window cap entry must be an object with recipient and cap fields",
          });
          continue;
        }
        const rcObj = rc as Record<string, unknown>;
        if (!isValidStellarAddress(rcObj.recipient)) {
          failures.push({
            path: `recipient_window_caps[${i}].recipient`,
            rule: "invalid_address",
            message: `"${rcObj.recipient}" is not a valid Stellar address`,
          });
        } else {
          const norm = normalizeStellarAddress(rcObj.recipient)!;
          if (seenCapRecipients.has(norm)) {
            failures.push({
              path: `recipient_window_caps[${i}].recipient`,
              rule: "duplicate_recipient_window_cap",
              message: `duplicate recipient "${rcObj.recipient}" in recipient_window_caps`,
            });
          }
          seenCapRecipients.add(norm);
          if (guardAddress && norm === guardAddress) {
            failures.push({
              path: `recipient_window_caps[${i}].recipient`,
              rule: "self_as_recipient_cap",
              message: "guard contract address cannot be listed in recipient_window_caps",
            });
          }
        }

        if (rcObj.cap === undefined || rcObj.cap === null) {
          failures.push({
            path: `recipient_window_caps[${i}].cap`,
            rule: "missing_field",
            message: "recipient window cap requires a cap amount",
          });
        } else if (!isIntegerLike(rcObj.cap)) {
          failures.push({
            path: `recipient_window_caps[${i}].cap`,
            rule: "invalid_type",
            message: "recipient window cap must be an integer or bigint",
          });
        } else {
          const capVal = toBigInt(rcObj.cap);
          if (capVal < 0n) {
            failures.push({
              path: `recipient_window_caps[${i}].cap`,
              rule: "negative_amount",
              message: "recipient window cap must be non-negative (>= 0)",
            });
          }
          // SPEC §8 bullet 3: A per-recipient cap > 0 requires window_secs != 0
          if (capVal > 0n && windowSecs !== null && windowSecs === 0n) {
            failures.push({
              path: `recipient_window_caps[${i}].cap`,
              rule: "recipient_cap_requires_window",
              message: "per-recipient window cap > 0 requires window_secs != 0",
            });
          }
        }
      }
    }
  }

  // 10. active_from and active_until (SPEC §8 bullet 1 & 4)
  let activeFrom: bigint | null = null;
  if (raw.active_from === undefined || raw.active_from === null) {
    failures.push({
      path: "active_from",
      rule: "missing_field",
      message: "active_from is required",
    });
  } else if (!isIntegerLike(raw.active_from)) {
    failures.push({
      path: "active_from",
      rule: "invalid_type",
      message: "active_from must be an integer or bigint",
    });
  } else {
    activeFrom = toBigInt(raw.active_from);
    if (activeFrom < 0n) {
      failures.push({
        path: "active_from",
        rule: "negative_amount",
        message: "active_from must be non-negative (>= 0)",
      });
    }
  }

  let activeUntil: bigint | null = null;
  if (raw.active_until === undefined || raw.active_until === null) {
    failures.push({
      path: "active_until",
      rule: "missing_field",
      message: "active_until is required",
    });
  } else if (!isIntegerLike(raw.active_until)) {
    failures.push({
      path: "active_until",
      rule: "invalid_type",
      message: "active_until must be an integer or bigint",
    });
  } else {
    activeUntil = toBigInt(raw.active_until);
    if (activeUntil < 0n) {
      failures.push({
        path: "active_until",
        rule: "negative_amount",
        message: "active_until must be non-negative (>= 0)",
      });
    }
  }

  // SPEC §8 bullet 4: active_until == 0 || active_until > active_from
  if (activeFrom !== null && activeUntil !== null) {
    if (activeUntil !== 0n && activeUntil <= activeFrom) {
      failures.push({
        path: "active_until",
        rule: "active_window_inverted",
        message: "active_until must be 0 (no expiration) or strictly greater than active_from",
      });
    }
  }

  // 11. paused (type check)
  if (typeof raw.paused !== "boolean") {
    failures.push({
      path: "paused",
      rule: "invalid_type",
      message: "paused must be a boolean",
    });
  }

  // 12. dms_grace_secs (SPEC §8 bullet 1)
  if (raw.dms_grace_secs === undefined || raw.dms_grace_secs === null) {
    failures.push({
      path: "dms_grace_secs",
      rule: "missing_field",
      message: "dms_grace_secs is required",
    });
  } else if (!isIntegerLike(raw.dms_grace_secs)) {
    failures.push({
      path: "dms_grace_secs",
      rule: "invalid_type",
      message: "dms_grace_secs must be an integer or bigint",
    });
  } else if (toBigInt(raw.dms_grace_secs) < 0n) {
    failures.push({
      path: "dms_grace_secs",
      rule: "negative_amount",
      message: "dms_grace_secs must be non-negative (>= 0)",
    });
  }

  return failures;
}