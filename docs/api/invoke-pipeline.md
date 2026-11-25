# Invoke Pipeline API

## `invoke(params: InvokeParams): Promise<InvokeOutcome>`

Executes an end-to-end transaction through the guard:
1. Runs probe simulation to collect required authorization entries.
2. Signs authorization entries with the agent signer (`GuardAuthorization.agent`:
   an `AgentSigner`, or a plain Ed25519 `Keypair` for the single-key default).
3. Runs enforced simulation through `__check_auth`.
4. Assembles transaction envelope and submits to Soroban RPC.
5. Handles transient `scecExceededLimit` ledger resource errors with bounded retry.
6. Handles minimum-fee broadcast rejections (`tx_insufficient_fee` / "tx too cheap") with bounded fee-bump retry.

Returns discriminated union: `{ kind: "allowed", submission, ... }`, `{ kind: "blocked", reason, ... }`, `{ kind: "pending", transactionHash, ... }`, or `{ kind: "error", detail, ... }` (or throws/returns `BroadcastError` on retry exhaustion).

### Options

#### `InvokeOptions` (alias of `InvokeParams`; `invoke(options)`)

Every caller-controlled option is validated before any signing or RPC; a bad value throws a field-specific `RangeError`.

| Option | Type | Default | Meaning |
| --- | --- | --- | --- |
| `server` | `rpc.Server` | required | Soroban RPC for simulation, submission and polling. |
| `source` | `Keypair \| AdminSigner` | required | Classic account that pays the fee and supplies the sequence number. |
| `call` | `ContractCall` | required | The contract call to run. |
| `networkPassphrase` | `string` | required | Network the envelope is built and signed for. |
| `guardAuth` | `GuardAuthorization \| null` | none — no smart-account authorization is signed | Present when the call needs the guarded account's own authorization (guard address plus agent signer). |
| `accountSigners` | `Array<Keypair \| AdminSigner>` | none | Extra classic-account authorizers (e.g. an admin). |
| `dryRun` | `boolean` | `false` | Stop before broadcast and return the full pre-broadcast trace. A dry run never submits. |
| `retry` | `InvokeRetryOptions` | `DEFAULT_INVOKE_RETRY_OPTIONS`: `maxAttempts: 3`, `baseDelayMs: 100`, `maxDelayMs: 2000` | Bounded full-jitter retry for stale-ledger resource-limit failures. Also accepts `random` / `jitter` (not both), `sleep`, and `initialDelayMs` (alias of `baseDelayMs`; must match it when both are set). `maxAttempts` counts the first attempt. |
| `pollAttempts` | `number` (integer ≥ 1) | `20` | Status polls after a broadcast. ⚠️ Exhausting them returns the `pending` outcome: the transaction was accepted but not confirmed. Do not rebroadcast without `server.getTransaction(hash)`. |
| `pollIntervalMs` | `number` (≥ 0) | `3000` | Delay between status polls. |
| `pollOptions` | `{ pollAttempts?, pollIntervalMs? }` | none — the top-level values apply | Nested spelling of the two poll options; must agree with the top-level values when both are set. |
| `feeBump` | `FeeBumpConfig` | `maxAttempts: 3`, `feeMultiplier: 2`, `initialInclusionFee: 100n` | Bounded fee-increase retry on minimum-fee broadcast rejections. Every attempt is re-simulated and re-enforced by the guard. `maxAttempts` is an integer ≥ 1, `feeMultiplier` is finite and > 1, `initialInclusionFee` accepts a positive `bigint` or base-10 integer string in stroops, and optional `maxInclusionFee` (same shapes, greater than the initial fee) is a hard ceiling: a breach stops retrying and returns an `error` outcome carrying `FeeCapExceededError` instead of broadcasting the over-cap transaction. |
| `maxRetries` | `number` (integer ≥ 0) | none — each retry class keeps its own budget | Overall cap across retry classes; `0` means a single attempt. The tighter of this and a per-class budget wins. |
| `fee` | `bigint \| string` | `100` stroops (`INCLUSION_FEE`) | Inclusion fee for the envelope; set internally on fee-bump retries. |
| `signal` | `AbortSignal` | none | ⚠️ An aborted run stops at the next RPC boundary and returns the `error` outcome carrying `RpcTimeoutError`; an already-aborted signal issues no RPC. The in-flight HTTP request itself is not cancelled. |
| `timeoutMs` | `number` (≥ 0) | `DEFAULT_RPC_TIMEOUT_MS` (30 000 ms) per RPC call | ⚠️ A fired timeout is the same fail-closed `error` outcome as an abort. `0` disables the per-call timeout (a `deadlineMs` still applies). |
| `deadlineMs` | `number` (> 0) | none — only the per-call `timeoutMs` applies | ⚠️ One budget for discovery, signing, simulation, retry backoff, broadcast and polling. Expiry is fail-closed (`RpcTimeoutError` with `deadline: true`), even after the guard approved the call; a dry run reports `undetermined`. |
| `clock` | `Clock` | `systemClock` | Time source for deadline accounting and poll/backoff delays. Must have `now()` and `sleep()`. |
| `onStep` | `(step: InvokeStepEvent) => void` | none | One event per stage attempt (probe → sign → simulate → broadcast). Exceptions are isolated. |
| `onRetry` | `(event: InvokeRetryEvent) => void` | none | Called once per retry, never for the first attempt, after the delay is chosen and before the next attempt starts. Carries `attempt`, `failure`, `cause`, `delayMs`, `nextAttempt`, and the `stage` that failed. Fee-bump retries report `delayMs: 0`. Exceptions are isolated: the hook cannot change the outcome, retry count or delay. |
| `onSubmitted` | `(event: SubmissionAcceptedEvent) => void` | none | Called once with the network's answer to the broadcast, before polling, so the transaction hash survives a failed poll. |
| `onQueue` | `(event: InvokeQueueEvent) => void` | none | Reports the per-source-account queue: `waiting` when a call joins, `acquired` when it runs, with `source`, `depth`, `waitedMs` and `acquired`. Events fire in acquisition order; a throwing hook is isolated. Counters belong to the `rpc.Server` object's queue state, so `invokeQueueStats(server)` reports only that server's accounts; without an argument it sums live server contexts in this process. The queue is per server object and process — another process using the same account is invisible. |
| `logger` | `GuardLoggerInput` | none — silent | Stage attempts and retries at `debug`, a refusal at `info`, no-verdict outcomes at `warn`. Never changes behaviour. |

### Fee-Bump Configuration (`feeBump`)

When network fee conditions change between prepare-time and broadcast, core may reject a transaction with a minimum-fee failure. The pipeline can automatically retry with an increased fee:

```typescript
const outcome = await invoke({
  server,
  source,
  call,
  networkPassphrase,
  feeBump: {
    maxAttempts: 3,        // Maximum attempts before returning BroadcastError (default: 3)
    feeMultiplier: 2,      // Multiplier applied to inclusion fee per retry (default: 2)
    initialInclusionFee: "100", // Base inclusion fee in stroops (default: 100 stroops)
    maxInclusionFee: 1_600n,    // Optional hard ceiling: never broadcast above it
  },
});
```

* **What it controls**: Controls bounded fee-increase retries when broadcast fails due to minimum-fee / "tx too cheap" rejections (`tx_insufficient_fee`).
* **Default behavior**: Enabled by default with up to 3 attempts, a 2x fee multiplier, and base inclusion fee of 100 stroops.
* **How attempts are bounded**: Configured via `maxAttempts` (default: 3) or overall `maxRetries`. When both are supplied the tighter bound wins. When exhausted, returns a typed `BroadcastError` containing attempt count, the last attempted fee, and structured retry metadata.
* **How the fee multiplier works**: On each retry, the inclusion fee is scaled by `feeMultiplier` (e.g. 100 stroops → 200 stroops → 400 stroops) and re-added to the simulated resource fee. The multiplier must be a finite number greater than `1`.
* **Hard ceiling**: `maxInclusionFee` bounds the inclusion fee a fee-bumped broadcast may declare. The computed fee is compared with the ceiling *before* the broadcast; on a breach the SDK stops retrying and returns an `error` outcome whose `error` is a `FeeCapExceededError` (attempted fee, ceiling, and `retry.maxInclusionFeeStroops`), so the over-cap transaction is never sent. The ceiling is validated synchronously at the `invoke()` boundary: a positive bigint or base-10 integer string, greater than `initialInclusionFee`.
* **Guard and Simulation Invariant**: **Every fee-bump attempt is re-prepared, re-simulated, and re-evaluated by the guard policy.** A fee bump NEVER bypasses simulation or guard enforcement. If re-simulation causes a policy block, the policy block is immediately surfaced and the transaction is never broadcast.

### The transaction hash, as soon as the server accepts the submission

The transaction hash is the operator's recovery handle after the broadcast:
it is what makes a transaction findable on an explorer when the SDK's own
confirmation polling is slow, times out, or fails. `invoke()` therefore
publishes it the moment the network answers, rather than only on the final
outcome.

```ts
const outcome = await invoke({
  server,
  source,
  call,
  networkPassphrase,
  onSubmitted: (event) => {
    // `event.hash` is the hash the network assigned; `event.status` is the
    // RPC's own status for the submission.
    recordTransactionHash(event.hash);
  },
});
```

The hook is called exactly once, immediately after `sendTransaction` resolves
and **before** any status polling, so a caller that records the hash keeps it
whatever happens afterwards. A throwing hook is isolated: it cannot change the
outcome, exactly like `onStep`.

**The ambiguous case.** A broadcast response that names no transaction is
reported as `hash: null` and **fails closed**: the SDK cannot poll for a
transaction it cannot name, so the invocation returns its `error` outcome with
a typed `BroadcastError` instead of claiming an untrackable transaction is on
its way. `hash: null` is the honest answer — "accepted, but not trackable".

**Keeping the hash on failure.** Every outcome that happened *after* a
broadcast carries the hash, so a caller never has to scrape it out of an error
string or a log line:

| Outcome | Where the hash is |
| --- | --- |
| `allowed` | `outcome.submission.hash` |
| `blocked` (post-broadcast refusal) | `outcome.transactionHash` |
| `pending` (accepted, not confirmed in budget) | `outcome.transactionHash` |
| `error` (failed poll, rejected transaction) | `outcome.transactionHash` |
| `error` (deadline spent while polling) | `outcome.transactionHash` |
| `InvokeRetryError` (retry budget exhausted) | `outcome.transactionHash` |

A `deadline` that fires while the pipeline is waiting for an inclusion does
not un-send the transaction: it may still land. The hash travels with the
`RpcTimeoutError` for exactly that reason.

### Observing retries as they happen (`onRetry`)

`invoke()` already attaches structured retry metadata to the terminal outcome. `onRetry` reports the same events *while* they happen, so a slow recovery does not look like a hang:

```ts
const outcome = await invoke({
  server,
  source,
  call,
  networkPassphrase,
  onRetry: (event) => {
    // event.attempt     — 1-based attempt that failed
    // event.failure     — "stale_ledger_resource_limit" | "sequence_number_collision" | "min_fee"
    // event.cause       — the coarse cause the terminal outcome would report
    // event.stage       — shared TRACE_STEP_NAMES stage where the failure was observed
    // event.delayMs     — backoff before the next attempt; 0 for a fee bump
    // event.nextAttempt — 1-based attempt that starts next
    metrics.increment("guard.invoke.retry", { failure: event.failure });
  },
});
```

The hook fires once per retry and never for the first attempt, so its events line up one-to-one, in order, with `outcome.retry.retries`. Retryable failures are classified from the broadcast's submission result, so `stage` is `"broadcast"` today. A throwing hook is swallowed — exactly like `onStep` — and cannot alter the retry budget, delays or outcome.

### The pending outcome: accepted, not confirmed

When the network has accepted the submission but the polling budget runs out
before inclusion is confirmed, `invoke()` returns `kind: "pending"` rather than
claiming either success or failure (issue #299):

```ts
const outcome = await invoke({ server, source, call, networkPassphrase });
if (outcome.kind === "pending") {
  outcome.transactionHash; // the hash the network assigned — query it, do not resend
  outcome.submission; // the `SubmissionResult` the broadcast produced
  outcome.detail; // one-line summary, e.g. "transaction <hash> submitted but unconfirmed after 3 poll attempt(s)"
  outcome.guidance; // safe follow-up text advising against rebroadcast
}
```

The distinction matters for correctness, not just ergonomics: a transaction
that was never sent and one that was sent but not yet confirmed require
**opposite** handling. Treating a `pending` outcome as a failure and
rebroadcasting risks executing the action twice, so the SDK reports the hash and
asks the caller to reconcile out of band — for example with
`server.getTransaction(outcome.transactionHash)`. `InvokePendingOutcome` is
exported by name so an adapter can narrow on it without re-declaring the shape.

`pending` is distinct from a `deadline` expiry: a deadline fires while the
pipeline still owns the whole invocation and returns the fail-closed `error`
outcome carrying `RpcTimeoutError`. `pending` means the submission itself
completed and only the confirmation polling ran out of budget.

### Resolving a pending outcome: `waitForTransaction()`

Rather than hand-rolling `getTransaction` polling, pass the hash to the
bounded helper. It reports what the chain did with the transaction as a
discriminated result and never throws on a non-confirmation:

```ts
import { waitForTransaction } from "stellar-agent-guard-sdk";

const outcome = await invoke({ server, source, call, networkPassphrase });
if (outcome.kind === "pending") {
  const status = await waitForTransaction({
    server,
    hash: outcome.transactionHash,
    timeoutMs: 30_000,    // overall budget; default 30s
    pollIntervalMs: 1_000, // delay between polls; default 1s
    signal,                // optional cancellation
    clock,                 // optional Clock (use FakeClock in tests)
  });

  switch (status.kind) {
    case "confirmed":
      status.ledger; // included in a ledger
      status.events; // contract events, when reported
      break;
    case "failed":
      status.resultCode; // the transaction was included and rejected
      break;
    case "pending":
      status.reason; // "timeout" | "aborted" — query again; do NOT resend
      break;
    case "undetermined":
      status.cause; // the RPC error that left the status unknown
      break;
  }
}
```

| Result | Meaning |
| --- | --- |
| `confirmed` | Included in a ledger. **Confirmation is not admissibility**: a guard refusal that reached inclusion is also an included transaction, so read the guard's decision from the original outcome/events. |
| `failed` | Included and rejected; carries `resultXdr`, `resultCode` and `diagnosticEvents`. |
| `pending` | The budget (`reason: "timeout"`) or the caller's signal (`reason: "aborted"`) ended the wait before a verdict. The transaction may still land — never rebroadcast on this result. |
| `undetermined` | An RPC error left the status unknown; `cause` carries the failure. |

Only invalid input throws — a malformed hash, or a non-positive `timeoutMs`/`pollIntervalMs` — synchronously and before any RPC, as a typed `InvalidInputError`. The first poll happens immediately, and every poll is bounded by the remaining budget, so the wait cannot outlive `timeoutMs`.

### Malformed simulation data

A simulation response the SDK cannot trust is reported with the SDK's typed
`ContractResponseError`, naming the field that was wrong and the stage that
read it — never a native conversion error.

```ts
const outcome = await invoke({ server, source, call, networkPassphrase });
if (outcome.kind === "error" && outcome.error instanceof ContractResponseError) {
  outcome.error.field;  // e.g. "minResourceFee"
  outcome.error.stage;  // e.g. "assemble" | "simulate" | "preflight"
}
```

The resource fee is the case in point: it is read through the shared exact-u64
parser, so a missing, malformed, negative or out-of-range fee is rejected
instead of being converted. The pipeline stops before the broadcast, and a dry
run reports `undetermined` rather than an admissible verdict with a fabricated
price.

### Option validation

Every caller-controlled option is checked at the public `invoke()` boundary,
before the account queue, signing or any RPC request. Invalid values are a
field-specific `RangeError` naming the offending option (for example
`retry.maxAttempts must be an integer >= 1 (received 0)`), and no RPC method is
called. The validated fields are:

| Option | Requirement |
| --- | --- |
| `retry.maxAttempts` | integer `>= 1` |
| `retry.baseDelayMs` / `retry.initialDelayMs` | finite `>= 0`; the aliases must agree when both are supplied |
| `retry.maxDelayMs` | finite `>= 0` and `>= baseDelayMs` |
| `retry.random` / `retry.jitter` | at most one function; it must return a finite sample in `[0, 1)` |
| `maxRetries` | integer `>= 0`; `0` means one attempt |
| `feeBump.maxAttempts` | integer `>= 1` |
| `feeBump.feeMultiplier` | finite `> 1` |
| `feeBump.initialInclusionFee` | positive `bigint` or base-10 integer string in stroops (through the Stellar u64 fee limit) |
| `feeBump.maxInclusionFee` | positive `bigint` or base-10 integer string in stroops, greater than `feeBump.initialInclusionFee` |
| `pollAttempts` | integer `>= 1` |
| `pollIntervalMs` | finite `>= 0` |
| `pollOptions.*` | same rules; nested and top-level values must agree when both are supplied |
| `timeoutMs` | finite `>= 0` (`0` disables the per-call bound) |
| `deadlineMs` | finite `> 0` |
| `clock` | object with `now()` and `sleep()` |

A jitter source that returns `NaN`, `Infinity`, a negative value, or `1` or above
is rejected with `retry.random must return a finite value in [0, 1)` the first
time it is sampled — before the retry sleeps or any further RPC is made.

### Overall deadline

`timeoutMs` bounds an RPC call (and defaults to 30s). `deadlineMs` bounds the
**whole invocation** from the moment `invoke()` starts: discovery, signing,
enforced simulation, retry backoff, assembly, broadcast and post-submit polling
all consume the same remaining budget. Pass `clock` (for example a `FakeClock`)
to make deadline accounting deterministic in tests.

```ts
const outcome = await invoke({
  server,
  source,
  call,
  networkPassphrase,
  timeoutMs: 30_000, // per-RPC bound
  deadlineMs: 45_000, // whole action, including retries and polling
  pollOptions: { pollAttempts: 10, pollIntervalMs: 2_000 },
});
```

Expiry is fail-closed. The pipeline returns its `error` outcome carrying an
`RpcTimeoutError` with `deadline: true` (and the stage that was in flight). It
never returns `allowed`, never publishes a `blocked` verdict it did not receive,
and never turns a guard approval that arrived after the budget into an
admissible result. A dry run reports `kind: "dry_run"` with
`verdict: "undetermined"` and `admissible: false`. A transaction already sent
when the deadline expires may still be included; the caller still gets the
timeout outcome and must reconcile it out of band.

### Retry metadata

Terminal outcomes carry additive `retry` metadata: `allowed`, `blocked` and
`pending` outcomes, the `error` outcome, `InvokeRetryError`, and a
fee-bump-exhausted `BroadcastError`.

```ts
export interface InvokeRetryMetadata {
  attempts: number; // actual pipeline attempts, including the first
  maxAttempts: number; // budget for the terminal failure class
  retried: boolean;
  exhausted: boolean;
  totalDelayMs: number;
  retries: Array<{
    attempt: number; // 1-based attempt that failed
    failure: "stale_ledger_resource_limit" | "sequence_number_collision" | "min_fee";
    cause: "undetermined" | "stale_ledger_resource_limit" | "sequence_number_collision";
    delayMs: number; // 0 for an immediate fee-bump retry
  }>;
  terminalFailure: RetryableInvokeFailure | null;
  terminalCause: InvokeErrorCause | null;
  outcome: "allowed" | "blocked" | "pending" | "error";
}
```

`retries` records failures that led to another attempt; a failure that exhausted
the budget is reported once in `terminalFailure`/`terminalCause` and
`exhausted: true`. The record contains no secrets, signatures, diagnostic
payloads, transaction hashes or XDR, so it is safe to log.
