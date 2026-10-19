/**
 * Transaction construction for a guarded smart account.
 *
 * ## Why this module exists
 *
 * The `stellar` CLI cannot sign a Soroban authorization entry whose address is
 * a *contract* (the guard): it only signs for the transaction source account
 * and fails with "Missing signing key for account C…". The only way to exercise
 * a custom account's `__check_auth` is to build the `SorobanAuthorizationEntry`
 * for the guard address yourself and sign its payload with the registered
 * agent key — which is what this module does, in TypeScript.
 *
 * ## What is signed
 *
 * The host hands `__check_auth` the SHA-256 digest of
 * `HashIdPreimage::SorobanAuthorization { network_id, nonce,
 * signature_expiration_ledger, invocation }`, and the guard verifies it with
 * `env.crypto().ed25519_verify(registered_agent_pubkey, digest, signature)`.
 * So the signature here is a raw 64-byte Ed25519 signature over that digest,
 * carried as `ScVal::Bytes` inside `SorobanAddressCredentials` — not the
 * `Vec[Map{public_key, signature}]` shape the SDK's `authorizeEntry` helper
 * produces for classic-account credentials.
 *
 * The nonce must never repeat for the guard address: the host records every
 * consumed nonce in ledger state and rejects replays. Strictly-increasing
 * transaction sequence numbers are unique per transaction and never reused, so
 * the sequence doubles as the nonce (same choice as the Phase 1 `agent-tx`
 * tool, which proved this path on-chain).
 *
 * ## Why there is an `AgentSigner` seam
 *
 * v1 registers exactly one Ed25519 agent key, so this module used to take a
 * bare `Keypair` and call `keypair.sign(digest)`. Contracts v2 will change the
 * guard's own `Signature` type to something multi-key (a threshold scheme),
 * and the SDK should absorb that without another breaking change to every
 * caller's config object. `AgentSigner` is the seam that allows it: the SDK
 * depends on "something that signs the authorization digest", not on
 * "something that is a `Keypair`". The single-key `Keypair` remains a valid
 * input everywhere, wrapped by `keypairAgentSigner` / `toAgentSigner` — the
 * current behaviour is unchanged, and multi-key support lands behind the same
 * interface when the contracts decision does. Research, options and the revisit
 * trigger: `docs/concepts/multi-key-agent-signing.md`.
 */
import {
  Account,
  Address,
  Keypair,
  SorobanDataBuilder,
  StrKey,
  Transaction,
  TransactionBuilder,
  rpc,
  scValToNative,
  verify as verifyEd25519,
  xdr,
} from "@stellar/stellar-sdk";
import {
  BroadcastError,
  ContractResponseError,
  SigningError,
  SimulationError,
} from "./errors.ts";
import { systemClock, type Clock } from "./clock.ts";
import { bytesToHex, sha256 } from "./hash.ts";
import type { ContractAddress } from "./policy.ts";

/** Extra ledger validity granted to a guard auth entry when it is signed. */
const SIG_EXPIRATION_LEDGERS = 10_000;
/** Inclusion fee floor, in stroops, for a single-operation transaction. */
const INCLUSION_FEE = "100";
const MAX_RESOURCE_FEE = 2n ** 64n - 1n;

export interface ContractCall {
  /** Contract address (C…) to invoke. */
  contract: ContractAddress;
  /** Function name as it appears in the contract spec. */
  fn: string;
  args: xdr.ScVal[];
}

/**
 * Parse the RPC's simulation resource fee without allowing a missing or
 * malformed value to masquerade as a free transaction.
 *
 * Stellar SDK versions have surfaced this field as a decimal string, number,
 * or bigint. All three are accepted only when they are an exact non-negative
 * u64. A missing field is invalid, not zero: callers must report the simulation
 * as undetermined rather than make a budget decision from fabricated pricing.
 */
export function parseSimulationResourceFee(raw: unknown): bigint {
  let value: bigint;
  if (typeof raw === "bigint") {
    value = raw;
  } else if (typeof raw === "number" && Number.isSafeInteger(raw)) {
    value = BigInt(raw);
  } else if (typeof raw === "string" && /^\d+$/.test(raw)) {
    value = BigInt(raw);
  } else {
    throw new ContractResponseError(
      `simulation returned an invalid resource fee: ${JSON.stringify(raw)}`,
      { field: "minResourceFee" },
    );
  }

  if (value < 0n || value > MAX_RESOURCE_FEE) {
    throw new ContractResponseError(
      `simulation resource fee ${value} is outside the u64 range`,
      { field: "minResourceFee" },
    );
  }
  return value;
}

/** The guard's own persistent storage keys, as they exist in ledger state. */
export const GUARD_STORAGE_KEYS = [
  "Policy",
  "Window",
  "LastHeartbeat",
  "AdminFrozen",
] as const;

/** Stable identity for a ledger key, for de-duplicating footprint entries. */
function ledgerKeyId(key: xdr.LedgerKey): string {
  return bytesToHex(key.toXDR());
}

export function addressToScVal(strkey: string): xdr.ScVal {
  return new Address(strkey).toScVal();
}

/**
 * Verify an Ed25519 agent-auth signature without accepting or deriving a
 * private key.
 *
 * `publicKey` accepts the registered account strkey (`G…`) or the raw 32-byte
 * public key stored by the contract. The Stellar SDK's low-level Ed25519
 * verifier is the same primitive used by `Keypair.verify` and the Stellar auth
 * path, so callers do not need a second cryptographic implementation.
 *
 * `payload` is verified exactly as supplied and is never re-hashed. The guard
 * verifies the host-provided 32-byte `HashIdPreimage` digest, so an integration
 * checking an auth entry must pass that same digest. Malformed keys, payloads that
 * are not 32 bytes, non-64-byte signatures, and verification failures all return
 * `false`; this diagnostic
 * helper does not throw for attacker-controlled input.
 */
export function verifyAgentSignature(
  publicKey: string | Uint8Array,
  payload: Uint8Array,
  signature: Uint8Array,
): boolean {
  try {
    const rawPublicKey =
      typeof publicKey === "string" ? StrKey.decodeEd25519PublicKey(publicKey) : publicKey;
    if (rawPublicKey.length !== 32 || payload.length !== 32 || signature.length !== 64) return false;
    return verifyEd25519(payload, signature, rawPublicKey);
  } catch {
    return false;
  }
}

export function invocationArgs(call: ContractCall): xdr.InvokeContractArgs {
  return new xdr.InvokeContractArgs({
    contractAddress: new Address(call.contract).toScAddress(),
    functionName: call.fn,
    args: call.args,
  });
}

/**
 * Ledger keys for the guard's own storage. A `contracttype` enum in Rust is a
 * vector of symbols on the wire (`DataKey::Policy` → `[Symbol("Policy")]`), so
 * the keys are built to match real ledger state rather than as bare symbols.
 */
export function guardStorageLedgerKeys(guard: string): xdr.LedgerKey[] {
  const contract = new Address(guard).toScAddress();
  const keys = GUARD_STORAGE_KEYS.map((name) =>
    xdr.LedgerKey.contractData(
      new xdr.LedgerKeyContractData({
        contract,
        key: xdr.ScVal.scvVec([xdr.ScVal.scvSymbol(name)]),
        durability: xdr.ContractDataDurability.persistent,
      }),
    ),
  );
  keys.push(
    xdr.LedgerKey.contractData(
      new xdr.LedgerKeyContractData({
        contract,
        key: xdr.ScVal.scvLedgerKeyContractInstance(),
        durability: xdr.ContractDataDurability.persistent,
      }),
    ),
  );
  return keys;
}

export interface AdminSigner {
  /** Return public key (G...) of the admin */
  publicKey(): string | Promise<string>;
  /**
   * Sign a transaction envelope.
   * Accepts a Transaction and returns a signed Transaction or base64 XDR string.
   */
  signTransaction?(
    transaction: Transaction,
    options?: { networkPassphrase?: string },
  ): Promise<Transaction | string> | Transaction | string;
  /** Direct authorization entry signing hook */
  signAuthEntry?(
    entry: xdr.SorobanAuthorizationEntry,
    options: { signatureExpirationLedger: number; networkPassphrase: string },
  ): Promise<xdr.SorobanAuthorizationEntry>;
}

/**
 * The signing capability the guard's authorization needs — the seam that lets
 * N-key (or otherwise non-`Keypair`) agent signing land without a second
 * breaking change (see the module header and
 * `docs/concepts/multi-key-agent-signing.md`).
 *
 * It is deliberately the *digest* that crosses this boundary, not the XDR
 * entry: the host hashes the authorization preimage and hands `__check_auth`
 * the 32-byte digest, so a signer never has to understand Soroban XDR to be
 * usable here. `signDigest` may return synchronously (a local key) or as a
 * promise (a remote/HSM-backed signer); `buildGuardAuthEntry` awaits it.
 */
export interface AgentSigner {
  /** The signer's public identity, for diagnostics and key matching. */
  readonly publicKey: string;
  /** Sign the 32-byte SHA-256 digest `__check_auth` will verify. */
  signDigest(digest: Uint8Array): Uint8Array | Promise<Uint8Array>;
}

/**
 * The current single-key signer: a local Ed25519 `Keypair`, exposed through
 * the `AgentSigner` interface. One key, one raw 64-byte signature — exactly the
 * behaviour the SDK has always had.
 */
export function keypairAgentSigner(agent: Keypair): AgentSigner {
  return {
    publicKey: agent.publicKey(),
    signDigest: (digest) => agent.sign(digest),
  };
}

/**
 * Accept either a ready-made `AgentSigner` or a plain `Keypair`.
 *
 * The `Keypair` branch is what keeps this refactor non-breaking: every existing
 * caller passing a keypair still works, and only a caller with a genuinely
 * different signing setup has to supply the interface itself.
 */
export function toAgentSigner(signer: AgentSigner | Keypair): AgentSigner {
  if (typeof (signer as AgentSigner).signDigest === "function") {
    return signer as AgentSigner;
  }
  return keypairAgentSigner(signer as Keypair);
}

/**
 * Build and sign the guard's authorization entry for one call.
 *
 * `nonce` and `signatureExpirationLedger` are written into the signed payload,
 * so the returned entry is only valid for that nonce — build a fresh entry per
 * submission rather than reusing one.
 *
 * Async because an `AgentSigner` may be: a remote or threshold signer resolves
 * its signatures as a promise. The single-`Keypair` path still resolves
 * immediately, so this is a source-compatible widening for `await`ing callers
 * and a signature change for callers that used the return value synchronously.
 */
/**
 * Credential kinds the host may demand for this account.
 *
 * Which one arrives is not the caller's choice — the RPC reports what the call
 * requires, and it differs by call shape: an SAC `transfer` authorized by the
 * account comes back as legacy `sorobanCredentialsAddress`, while a self-call
 * such as `heartbeat` comes back as `sorobanCredentialsAddressV2` (CAP-71),
 * whose signed payload additionally binds the account address.
 *
 * The contract itself is indifferent: `__check_auth` verifies the Ed25519
 * signature against whatever digest the host presents, so the SDK's job is to
 * build the preimage that matches the credential type it is answering.
 */
export type GuardCredentialType =
  | "sorobanCredentialsAddress"
  | "sorobanCredentialsAddressV2";

export async function buildGuardAuthEntry(params: {
  guard: string;
  call: ContractCall;
  /**
   * The account's agent signer. A `Keypair` is accepted for the single-key case
   * and wrapped via `toAgentSigner`; supply an `AgentSigner` directly for any
   * other signing setup.
   */
  signer: AgentSigner | Keypair;
  nonce: bigint;
  signatureExpirationLedger: number;
  networkPassphrase: string;
  credentialType?: GuardCredentialType;
}): Promise<xdr.SorobanAuthorizationEntry> {
  const {
    guard,
    call,
    signer: rawSigner,
    nonce,
    signatureExpirationLedger,
    networkPassphrase,
    credentialType = "sorobanCredentialsAddress",
  } = params;
  const signer = toAgentSigner(rawSigner);
  const rootInvocation = new xdr.SorobanAuthorizedInvocation({
    function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
      invocationArgs(call),
    ),
    subInvocations: [],
  });
  const networkId = sha256(networkPassphrase);
  const guardAddress = new Address(guard).toScAddress();

  const preimage =
    credentialType === "sorobanCredentialsAddressV2"
      ? xdr.HashIdPreimage.envelopeTypeSorobanAuthorizationWithAddress(
          new xdr.HashIdPreimageSorobanAuthorizationWithAddress({
            networkId,
            nonce,
            invocation: rootInvocation,
            address: guardAddress,
            signatureExpirationLedger,
          }),
        )
      : xdr.HashIdPreimage.envelopeTypeSorobanAuthorization(
          new xdr.HashIdPreimageSorobanAuthorization({
            networkId,
            nonce,
            invocation: rootInvocation,
            signatureExpirationLedger,
          }),
        );

  const digest = sha256(preimage.toXDR());
  let signature: Uint8Array;
  try {
    signature = await signer.signDigest(digest);
  } catch (error) {
    // A signer that cannot produce a signature is a `SigningError` at the layer
    // that owns the failure, so a direct caller of this helper gets the same
    // typed category an `invoke()` caller would have gotten.
    throw new SigningError("could not sign the guard authorization entry", {
      address: guard,
      cause: error,
    });
  }

  const addressCredentials = new xdr.SorobanAddressCredentials({
    address: guardAddress,
    nonce,
    signatureExpirationLedger,
    signature: xdr.ScVal.scvBytes(signature),
  });

  return new xdr.SorobanAuthorizationEntry({
    credentials:
      credentialType === "sorobanCredentialsAddressV2"
        ? xdr.SorobanCredentials.sorobanCredentialsAddressV2(addressCredentials)
        : xdr.SorobanCredentials.sorobanCredentialsAddress(addressCredentials),
    rootInvocation,
  });
}

/**
 * Sign a classic-account authorization entry (used for admin calls such as
 * `initialize` / `set_policy`, where the authorizer is a normal keypair or
 * an AdminSigner rather than the smart account).
 */
export async function signAccountAuthEntry(params: {
  entry: xdr.SorobanAuthorizationEntry;
  signer: Keypair | AdminSigner;
  signatureExpirationLedger: number;
  networkPassphrase: string;
}): Promise<xdr.SorobanAuthorizationEntry> {
  const { entry, signer, signatureExpirationLedger, networkPassphrase } = params;
  try {
    if ("signAuthEntry" in signer && typeof signer.signAuthEntry === "function") {
      return await signer.signAuthEntry(entry, { signatureExpirationLedger, networkPassphrase });
    }
    if ("sign" in signer && typeof (signer as Keypair).sign === "function") {
      const { authorizeEntry } = await import("@stellar/stellar-sdk");
      return await authorizeEntry(
        entry,
        signer as Keypair,
        signatureExpirationLedger,
        networkPassphrase,
      );
    }
  } catch (error) {
    throw new SigningError("could not sign the required account authorization entry", {
      address: await signer.publicKey(),
      cause: error,
    });
  }
  // For classic transaction signers (e.g. Freighter) without a separate auth-entry signer,
  // return entry to be authorized via the envelope signature.
  return entry;
}

export interface SimulationOutcome {
  /** Raw simulation response, for callers that need events or cost data. */
  raw: rpc.Api.SimulateTransactionResponse;
  blocked: { code?: string; message: string } | null;
}

/**
 * Simulate a call whose authorization has already been signed.
 *
 * When the auth entry carries a valid agent signature, the RPC runs the *real*
 * `__check_auth` during simulation. A policy violation therefore surfaces here,
 * before broadcast, as a simulation error naming the reason symbol — this is
 * the interception point the SDK's pre-flight gate is built on.
 */
export async function simulateSigned(
  server: rpc.Server,
  transaction: Transaction,
): Promise<SimulationOutcome> {
  let raw: rpc.Api.SimulateTransactionResponse;
  try {
    raw = await server.simulateTransaction(transaction);
  } catch (error) {
    throw new SimulationError("signed transaction simulation request failed", {
      stage: "simulate",
      cause: error,
    });
  }
  if (rpc.Api.isSimulationError(raw)) {
    const error = raw as rpc.Api.SimulateTransactionErrorResponse;
    return {
      raw,
      blocked: {
        ...(typeof error.error === "string" ? { code: error.error } : {}),
        message: error.error ?? "simulation failed",
      },
    };
  }
  return { raw, blocked: null };
}

export interface AssembleResult {
  transaction: Transaction;
  /** Resource fee actually charged for the assembled transaction. */
  resourceFee: bigint;
  footprintKeys: number;
  /** Inclusion fee declared for the assembled transaction. */
  inclusionFee?: bigint | undefined;
}

/**
 * Assemble a submittable transaction from a successful simulation, merging the
 * guard's own storage keys into the footprint.
 *
 * RPC preflight prices what the *called* contract touches. A custom account's
 * `__check_auth` additionally reads and writes the account's own policy, window
 * and freeze state, so those keys must be present in the declared footprint and
 * the declared resource fee must cover them — otherwise core rejects the
 * transaction with `insufficient_refundable_fee`. Keys are merged, never
 * dropped, so a simulation that already priced them is unaffected.
 */
export function assembleFromSimulation(params: {
  simulation: rpc.Api.SimulateTransactionSuccessResponse;
  source: Account;
  operation: xdr.Operation;
  networkPassphrase: string;
  guard: string | null;
  extraResourceFee?: bigint | undefined;
  inclusionFee?: bigint | string | undefined;
}): AssembleResult {
  const { simulation, source, operation, networkPassphrase, guard } = params;
  // v17 hands back a builder already; older shapes hand back the data itself.
  const data =
    simulation.transactionData instanceof SorobanDataBuilder
      ? simulation.transactionData
      : new SorobanDataBuilder(simulation.transactionData);
  let footprintKeys = 0;

  if (guard) {
    const merged = [...data.getReadWrite()];
    // De-duplicate against BOTH footprint lists. A key appearing in read_only and
    // read_write at once is an invalid footprint and the network rejects the
    // transaction with `tx_soroban_invalid` — and RPC preflight commonly places
    // the guard's own storage keys in read_only, so merging blindly into
    // read_write would duplicate every one of them.
    const seen = new Set([
      ...data.getReadOnly().map((key) => ledgerKeyId(key)),
      ...merged.map((key) => ledgerKeyId(key)),
    ]);
    for (const key of guardStorageLedgerKeys(guard)) {
      const id = ledgerKeyId(key);
      if (!seen.has(id)) {
        seen.add(id);
        merged.push(key);
      }
    }
    data.setReadWrite(merged);
    footprintKeys = merged.length;
  }

  const minResourceFee = BigInt(simulation.minResourceFee);
  const extra = params.extraResourceFee ?? 0n;
  data.setResourceFee(minResourceFee + extra);

  const inclusionFee = (params.inclusionFee ?? INCLUSION_FEE).toString();

  // `TransactionBuilder` folds the resource fee declared in `sorobanData` into
  // the transaction fee on build(), so `fee` here is the inclusion fee only.
  const transaction = new TransactionBuilder(source, {
    fee: inclusionFee,
    networkPassphrase,
    sorobanData: data.build(),
  })
    .addOperation(operation)
    .setTimeout(0)
    .build();

  return { transaction, resourceFee: minResourceFee + extra, footprintKeys, inclusionFee: BigInt(inclusionFee) };
}

/**
 * Human-readable dump of a simulation's declared resources and footprint.
 *
 * A `scecExceededLimit` rejection *after* inclusion means the ledger charged
 * more of a resource than the transaction declared — a mismatch that only shows
 * up as two bare numbers in an error payload. This makes the declaration
 * legible next to the charge, which is the only way to tell an under-declaration
 * from a genuine limit.
 */
export function describeSimulationResources(
  simulation: unknown,
  guard: string | null,
): string {
  const candidate = simulation as {
    transactionData?: unknown;
    minResourceFee?: string | number;
    error?: unknown;
  };
  if (candidate.transactionData === undefined) {
    return `  (simulation error, no resources declared)\n  error: ${JSON.stringify(candidate.error)}`;
  }
  const data =
    candidate.transactionData instanceof SorobanDataBuilder
      ? candidate.transactionData
      : new SorobanDataBuilder(candidate.transactionData as never);
  const built = data.build();
  // The SDK's XDR classes expose camelCase properties (`writeBytes`,
  // `footprint.readWrite`); only their serialised JSON form uses the wire's
  // snake_case names. Reading the JSON shape here would silently yield
  // `undefined` for every field.
  const resources = (built as unknown as {
    resources: {
      instructions: number;
      diskReadBytes: number;
      writeBytes: number;
      footprint: { readOnly: unknown[]; readWrite: unknown[] };
    };
  }).resources;
  const declared = new Set(resources.footprint.readWrite.map((key) => ledgerKeyId(key as xdr.LedgerKey)));
  const own = guard
    ? guardStorageLedgerKeys(guard).map((key, index) => {
        const name = GUARD_STORAGE_KEYS[index] ?? `#${index}`;
        return declared.has(ledgerKeyId(key))
          ? `${name}: declared read_write`
          : `${name}: NOT in the footprint`;
      })
    : [];
  return [
    `  instructions: ${resources.instructions}`,
    `  disk_read_bytes: ${resources.diskReadBytes}`,
    `  write_bytes: ${resources.writeBytes}`,
    `  footprint: ${resources.footprint.readOnly.length} read-only, ${resources.footprint.readWrite.length} read-write`,
    `  minResourceFee: ${candidate.minResourceFee}`,
    ...own.map((line) => `  guard key ${line}`),
  ].join("\n");
}

/**
 * `resultXdr` arrives either as a base64 string or as a decoded value that
 * knows how to serialise itself, depending on SDK internals — normalise to a
 * string so failure reports are always copy-pasteable evidence.
 */
function resultXdrToString(result: unknown): string | null {
  const value = (result as { resultXdr?: unknown }).resultXdr;
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value;
  const serialisable = value as { toXDR?: (format: string) => string };
  if (typeof serialisable.toXDR === "function") return serialisable.toXDR("base64");
  return String(value);
}

export interface SubmissionResult {
  hash: string;
  status: string;
  ledger: number | null;
  /** Present when the network rejected the transaction after broadcast. */
  failure: {
    resultXdr: string | null;
    /** Contract-level arm derived from the result, e.g. `invokeHostFunctionResult=trap`. */
    resultCode: string | null;
    message: string;
    diagnosticEvents: unknown[];
  } | null;
  events: unknown[];
}

/** Recursively convert SDK XDR values into plain, inspectable objects. */
function toPlain(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined || depth > 8) return value ?? null;
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Uint8Array) return `0x${bytesToHex(value)}`;
  if (typeof value !== "object") return value;
  const withXdr = value as { toXdrObject?: () => unknown };
  if (typeof withXdr.toXdrObject === "function") {
    return toPlain(withXdr.toXdrObject(), depth + 1);
  }
  if (Array.isArray(value)) return value.map((item) => toPlain(item, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    out[key] = toPlain(item, depth + 1);
  }
  return out;
}

/**
 * Name the arm that caused a rejected transaction. A trap (`trap`) means the
 * contract itself panicked — the most useful thing to surface, since the guard
 * panics with a typed `Error` rather than a bare failure.
 */
export function describeTransactionResult(result: unknown): string | null {
  const plain = toPlain(result) as
    | { result?: { type?: string; results?: Array<{ tr?: Record<string, unknown> }> } }
    | null;
  const arm = plain?.result?.results?.[0]?.tr?.["invokeHostFunctionResult"] as
    | { type?: string }
    | undefined;
  if (arm?.type) return `invokeHostFunctionResult=${arm.type}`;
  if (plain?.result?.type) return `result=${plain.result.type}`;
  const directType = (result as { result?: { type?: string } })?.result?.type;
  if (typeof directType === "string") return `result=${directType}`;
  return null;
}

/** Render a diagnostic event's topics and data in the contract's vocabulary. */
function describeEvent(raw: unknown): string {
  const event = raw as {
    event?: { body?: { v0?: { topics?: xdr.ScVal[]; data?: xdr.ScVal } } };
  };
  const v0 = event?.event?.body?.v0;
  if (!v0) return "(unrecognised diagnostic event shape)";
  const render = (value: unknown): string => {
    if (value === undefined) return "()";
    try {
      return JSON.stringify(scValToNative(value as xdr.ScVal), (_k, v: unknown) =>
        typeof v === "bigint" ? v.toString() : v,
      );
    } catch {
      return "(undecodable)";
    }
  };
  const topics = (v0.topics ?? []).map(render).join(", ");
  return `topics=[${topics}] data=${render(v0.data)}`;
}

/**
 * Human-readable summary of the diagnostic events attached to a failure.
 * These are the host's and the contract's own words (`fn_call`, `error`, `log`),
 * which is what makes a trap diagnosable rather than opaque.
 */
export function summarizeDiagnosticEvents(events: unknown[]): string[] {
  return events.map(describeEvent);
}

/**
 * Was this post-inclusion failure a *stale-ledger resource declaration*?
 *
 * Diagnosed the hard way: the enforced simulation reports the write size for the
 * window state it observed, and when the RPC serves a ledger snapshot that
 * predates the write this SDK just made, the declared `writeBytes` is short by
 * exactly one rolling-window entry (72 bytes on this contract). The transaction
 * is then included and rejected by core with `scecExceededLimit` — a failure
 * that is not the caller's fault and not a policy decision.
 *
 * It is safe to re-simulate and retry: a transaction rejected for exceeding a
 * resource limit applies **nothing** (state is rolled back), and the very fact
 * of inclusion proves the ledger has since advanced past the stale snapshot.
 * Contract-level `Auth` failures are deliberately *not* matched here — those are
 * the guard doing its job and must surface as a block, not be retried.
 */
export function isStaleLedgerResourceFailure(
  failure: NonNullable<SubmissionResult["failure"]>,
): boolean {
  const haystack = [
    failure.message,
    failure.resultCode ?? "",
    ...failure.diagnosticEvents.map((event) => JSON.stringify(event)),
  ].join("\n");
  // The host names this `insufficient_refundable_fee` as an error code and
  // "insufficient refundable fee" in prose; match either spelling.
  return /scecExceededLimit|exceeds amount specified|insufficient[_ ]refundable[_ ]fee/i.test(
    haystack,
  );
}

/**
 * Was this post-broadcast rejection caused by a transaction fee below the network minimum?
 *
 * Simulation prices fees at prepare-time, but a fee-market change (e.g. surge
 * pricing or minimum inclusion fee floor increase) between transaction preparation
 * and broadcast causes core to reject the transaction with `tx_insufficient_fee` /
 * "tx too cheap" / min-fee errors.
 */
export function isMinimumFeeBroadcastFailure(
  failure: NonNullable<SubmissionResult["failure"]>,
): boolean {
  if (
    failure.resultCode === "result=txInsufficientFee" ||
    failure.resultCode === "txInsufficientFee" ||
    failure.resultCode === "tx_insufficient_fee"
  ) {
    return true;
  }
  const haystack = [failure.resultCode ?? "", failure.message].join("\n");
  return /tx_?insufficient_?fee|tx too cheap|tx_too_cheap|min(?:imum)?[ _-]fee/i.test(
    haystack,
  );
}

/**
 * Was a submission rejected because the source account sequence was stale?
 *
 * `tx_bad_seq` is the canonical code, but RPC error payloads are not perfectly
 * consistent across SDK and server versions. Keep the matching deliberately
 * narrow so ordinary transaction failures are never retried with a new sequence.
 */
export function isSequenceNumberFailure(
  failure: NonNullable<SubmissionResult["failure"]>,
): boolean {
  const haystack = [
    failure.message,
    failure.resultCode ?? "",
    ...failure.diagnosticEvents.map((event) => JSON.stringify(event)),
  ].join("\n");
  return /tx_bad_seq|bad[_ ]seq|sequence (?:number )?(?:is )?(?:too (?:low|high|small|large)|mismatch|does not match|already (?:been )?(?:used|spent))/i.test(
    haystack,
  );
}

export { BroadcastError } from "./errors.ts";

/** Full, copy-pasteable rendering of a failed submission, for evidence. */
export function describeSubmissionFailure(failure: NonNullable<SubmissionResult["failure"]>): string {
  const lines = [`resultCode: ${failure.resultCode ?? "unknown"}`, `message: ${failure.message}`];
  if (failure.resultXdr) lines.push(`resultXdr: ${failure.resultXdr}`);
  for (const summary of summarizeDiagnosticEvents(failure.diagnosticEvents)) {
    lines.push(`diagnostic: ${summary}`);
  }
  return lines.join("\n");
}

/** Submit a signed transaction and poll until it is included in a ledger. */
export async function submitAndPoll(
  server: rpc.Server,
  transaction: Transaction,
  signers: Array<Keypair | AdminSigner>,
  options: {
    pollAttempts?: number | undefined;
    pollIntervalMs?: number | undefined;
    clock?: Clock | undefined;
  } = {},
): Promise<SubmissionResult> {
  const clock = options.clock ?? systemClock;

  for (const signer of signers) {
    if ("signTransaction" in signer && typeof signer.signTransaction === "function") {
      const signed = await signer.signTransaction(transaction, {
        networkPassphrase: transaction.networkPassphrase,
      });
      if (typeof signed === "string") {
        transaction = new Transaction(signed, transaction.networkPassphrase);
      } else {
        transaction = signed;
      }
    } else if ("sign" in signer && typeof (signer as Keypair).sign === "function") {
      transaction.sign(signer as Keypair);
    }
  }

  let sent: Awaited<ReturnType<rpc.Server["sendTransaction"]>>;
  try {
    sent = await server.sendTransaction(transaction);
  } catch (error) {
    throw new BroadcastError("transaction submission request failed", { cause: error });
  }
  if (sent.status === "ERROR") {
    return {
      hash: sent.hash,
      status: sent.status,
      ledger: null,
      failure: {
        resultXdr: null,
        resultCode: describeTransactionResult(sent.errorResult),
        message: JSON.stringify(sent.errorResult ?? sent),
        diagnosticEvents: [],
      },
      events: [],
    };
  }

  const attempts = options.pollAttempts ?? 20;
  const interval = options.pollIntervalMs ?? 3_000;
  for (let attempt = 0; attempt < attempts; attempt++) {
    await clock.sleep(interval);
    let result: Awaited<ReturnType<rpc.Server["getTransaction"]>>;
    try {
      result = await server.getTransaction(sent.hash);
    } catch (error) {
      throw new BroadcastError(`could not poll transaction ${sent.hash}`, {
        transactionHash: sent.hash,
        cause: error,
      });
    }
    if (result.status === rpc.Api.GetTransactionStatus.SUCCESS) {
      return {
        hash: sent.hash,
        status: result.status,
        ledger: result.ledger ?? null,
        failure: null,
        events: (result as { events?: { contractEventsXdr?: unknown[] } }).events
          ?.contractEventsXdr ?? [],
      };
    }
    if (result.status === rpc.Api.GetTransactionStatus.FAILED) {
      const failed = result as unknown as {
        resultXdr?: unknown;
        diagnosticEventsXdr?: unknown[];
      };
      return {
        hash: sent.hash,
        status: result.status,
        ledger: result.ledger ?? null,
        failure: {
          resultXdr: resultXdrToString(result),
          resultCode: describeTransactionResult(failed.resultXdr),
          message: "transaction failed after inclusion",
          diagnosticEvents: failed.diagnosticEventsXdr ?? [],
        },
        events: [],
      };
    }
  }
  return {
    hash: sent.hash,
    status: "TIMEOUT",
    ledger: null,
    failure: {
      resultXdr: null,
      resultCode: null,
      message: "timed out waiting for ledger inclusion",
      diagnosticEvents: [],
    },
    events: [],
  };
}

/** Convenience wrapper: build the initial (footprint-declaring) envelope. */
export function buildInitialEnvelope(params: {
  source: Account;
  operation: xdr.Operation;
  networkPassphrase: string;
  guard: string | null;
  fee?: bigint | string | undefined;
}): Transaction {
  const builder = new TransactionBuilder(params.source, {
    fee: (params.fee ?? INCLUSION_FEE).toString(),
    networkPassphrase: params.networkPassphrase,
    ...(params.guard
      ? {
          sorobanData: new SorobanDataBuilder()
            .setReadWrite(guardStorageLedgerKeys(params.guard))
            .build(),
        }
      : {}),
  })
    .addOperation(params.operation)
    .setTimeout(0);
  return builder.build();
}

export { SIG_EXPIRATION_LEDGERS, INCLUSION_FEE };
