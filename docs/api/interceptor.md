# PreFlightInterceptor API

`PreFlightInterceptor` evaluates whether a planned contract call will be accepted by the guard contract.

## Constructor

```ts
constructor(options: PreFlightInterceptorOptions)
```

### Options

#### `PreFlightInterceptorOptions` (alias of `PreFlightConfig`)

`new PreFlightInterceptor(options)`. Validated at construction: a `cache` without `ttlMs`/`ttlLedgers`, or with a non-positive value, throws a `TypeError`.

| Option | Type | Default | Meaning |
| --- | --- | --- | --- |
| `server` | `rpc.Server` | required | Soroban RPC used for every ledger read and simulation. |
| `networkPassphrase` | `string` | required | Network the probe and enforced envelopes are built and signed for. Part of the cache and coalescing key. |
| `guard` | `ContractAddress` (`C…`) | required | The guarded smart account whose policy is enforced. |
| `agent` | `AgentSigner \| Keypair` | required | The key registered as the account's agent; signs the guard auth entry. A plain `Keypair` is the single-key default. |
| `source` | `Keypair` | required | Classic account that pays fees and supplies the sequence number. |
| `accountSigners` | `Keypair[]` | none | Authorizers for non-guard auth requirements (e.g. an admin on a policy call). |
| `policy` | `ReadonlyPolicyConfig \| null` | none — `checkBatch()` reads the `Policy` ledger entry | Used **only** for `checkBatch()` staging; `check()` always enforces through simulation. ⚠️ A supplied policy is trusted as-is: a stale snapshot makes batch window staging use outdated caps. An explicit `null` means "no policy to stage against", not a failed read. |
| `cache` | `PreFlightCacheOptions` | none — no cache; every `check()` simulates fresh | ⚠️ Opt-in. A cached verdict can be staler than one admitted transfer, so a hit can report `admissible` for a call the next simulation would block. See the cache table below. |
| `coalesceInFlight` | `boolean` | `true` | Concurrent identical `check()` calls share one in-flight run; the shared run keeps `DEFAULT_RPC_TIMEOUT_MS` (30 000 ms) and each waiter still applies its own `signal`/`timeoutMs`. The entry is dropped as soon as the run settles (it is not a cache). Checks that pass `onStep` are never coalesced. `false`: every call runs its own simulation (more RPC load, same verdicts). |
| `logger` | `GuardLoggerInput` | none — silent (`SILENT_LOGGER`) | Log sink for verdicts and cache hits/stores/invalidations. A logger never changes a verdict. |
| `onVerdict` | `(event: PreFlightVerdictEvent) => void` | none | **Observability only.** Invoked exactly once per verdict `check()` returns — admissible, blocked, undetermined, cache hit, coalesced or fail-closed timeout — after the decision is final. The event carries `kind`, `reason` (blocked only), `cached`, `durationMs`, `ledger` (when known) and `call` (`{ fn, contract }`, never arguments). A hook that throws, or rejects asynchronously, is caught and logged; the verdict and fee data are unchanged. Not invoked when input validation throws, because no verdict was produced. |
| `clock` | `Clock` | `systemClock` | Time source for cache TTL expiry. ⚠️ A fake or skewed clock outside tests changes when cached verdicts expire. |

#### `PreFlightCacheOptions` (`options.cache`)

Present only when you opt in. Entries are also discarded whenever the observed ledger advances, so a hit never crosses a ledger boundary. Call `invalidate(call?)` after a policy or account-state change.

| Option | Type | Default | Meaning |
| --- | --- | --- | --- |
| `ttlMs` | `number` | none — one of `ttlMs` / `ttlLedgers` is required | Maximum cache age in ms; positive and finite. Capped at 5 000 ms (one approximate ledger close). Takes precedence over `ttlLedgers` when both are set. ⚠️ Any TTL means a verdict may be up to that old. |
| `ttlLedgers` | `number` | none | Ledger spelling of `ttlMs` (× 5 000 ms), same 5 000 ms cap; positive and finite. |
| `policyRevision` | `PolicyRevision \| () => PolicyRevision \| Promise<PolicyRevision>` | none — the revision is not part of the key | Value or getter mixed into the cache key, so a policy change invalidates entries before the TTL elapses. ⚠️ Without it, a policy change inside the TTL is not seen until expiry, the next ledger, or `invalidate()`. A getter that throws or returns `undefined` bypasses the cache for that check (fresh simulation), never a reused verdict. |
| `maxEntries` | `number` (positive integer) | none — unbounded | Least-recently-used eviction once full. Eviction only removes entries, so it can never return an expired or cross-ledger verdict. Unbounded means memory grows with the number of distinct calls. |

#### `PreFlightCheckOptions` (`check(call, options)`)

| Option | Type | Default | Meaning |
| --- | --- | --- | --- |
| `onStep` | `(step: InvokeStepEvent) => void` | none | One event per enforcement-stage attempt (probe → sign → simulate). Supplying it opts this check out of coalescing. |
| `signal` | `AbortSignal` | none | ⚠️ Caller cancellation. An already-aborted signal returns before any RPC; a fired signal returns the fail-closed `undetermined` verdict carrying `RpcTimeoutError`, never a throw and never `admissible`. |
| `timeoutMs` | `number` | `DEFAULT_RPC_TIMEOUT_MS` (30 000 ms) per RPC call | ⚠️ A fired timeout returns the same fail-closed `undetermined` verdict as an abort. `0` disables the per-call timeout: with no `signal`, a stalled RPC can then hold the check open. |

#### `SimulationDiagnosticsOptions` / `SimulationDiagnostics` (`simulateForDiagnostics()`)

`simulateForDiagnostics(call, options?)` runs the same probe and enforced simulation as `check()` but returns **no verdict** — `authoritative` is the literal `false`. It is a debugging surface: nothing is signed for submission, broadcast or cached.

| Option | Type | Default | Meaning |
| --- | --- | --- | --- |
| `signal` | `AbortSignal` | none | Bounds the RPC calls exactly as `check()` does. |
| `timeoutMs` | `number` | `DEFAULT_RPC_TIMEOUT_MS` | Per-call bound, as in `check()`. |
| `onStep` | `(step: InvokeStepEvent) => void` | none | Observes the enforcement-stage attempts. |
| `includeRaw` | `boolean` | `false` | Retains the undecoded source payload on each decoded event. Off by default, so diagnostics are redacted. |

The result carries `ok`, `detail`, `resources`, `resourceFeeStroops`, decoded `events`, the first `guardEvent`, and the typed `error` when the simulations could not complete. |
| `forceFresh` | `boolean` | `false` | Bypasses the verdict cache for this call: a new simulation runs, no cached verdict is reused, and no coalesced run is joined. The cache is left untouched (nothing read, nothing stored). Use it before a high-value transfer when a hit's `ageMs`/`observedLedger` is older than you accept. |

#### `CheckBatchOptions` (`checkBatch()` / `assertBatchAllowed()`)

| Option | Type | Default | Meaning |
| --- | --- | --- | --- |
| `policy` | `ReadonlyPolicyConfig \| null` | the constructor's `policy`; if that is absent too, a live read of the `Policy` ledger entry | Policy the batch is staged against. ⚠️ A failed or malformed read is never treated as "no cap": any positive SAC transfer in the batch becomes `undetermined`. |
| `initialWindowSpent` | `bigint` | a live read of the `Window` ledger entry; `0n` only when that entry does not exist | Committed spend already in the window. An explicit value (including `0n`) is a trusted caller snapshot. ⚠️ A failed read is not treated as zero: transfers that need it become `undetermined`. |
| `onStep` | `(step: InvokeStepEvent) => void` | none | Forwarded to each call's `check()`. |
| `signal` | `AbortSignal` | none | ⚠️ Forwarded to each call's `check()`: once it fires, every remaining call returns a fail-closed `undetermined` verdict without issuing an RPC. It does **not** bound the initial `Policy`/`Window` ledger reads; supply `policy` and `initialWindowSpent` to avoid them. |
| `timeoutMs` | `number` | `DEFAULT_RPC_TIMEOUT_MS` (30 000 ms), per call | Forwarded to each `check()`; a fired timeout makes that call `undetermined` and the batch continues. |
| `deadlineMs` | `number` (> 0) | none | One absolute budget for the whole batch, measured on the injected `clock`. Once spent, no further call starts and every unfinished call is a fail-closed `undetermined` verdict carrying an `RpcTimeoutError` with `deadline: true`. A batch that exceeds its deadline is never `admissible`; `timeoutMs` stays per-call, capped by the remaining budget. |

### Optional cache

Set either `cache.ttlMs` or `cache.ttlLedgers` to opt in. The effective TTL is
capped at one approximate five-second ledger-close interval, and a cached entry
is discarded when the observed ledger advances. `policyRevision` may be a value
or an async getter; changing it invalidates the matching entry. Call
`invalidate(call?)` after policy or account-state changes. A cached verdict can
be staler than one admitted transfer, so callers must accept that tradeoff
explicitly.

`maxEntries` bounds how many verdicts the cache retains. When the cache is full,
storing a new call fingerprint evicts the least-recently-used entry; a hit counts
as use, so the eviction order is deterministic. Eviction only removes entries —
lookups still require a current-ledger, unexpired entry — so a bounded cache
never returns an expired or cross-ledger verdict. Omit `maxEntries` for an
unbounded cache.

#### Staleness contract

A cache hit is a real verdict computed against an earlier state. It is reused
only inside the same ledger and inside its TTL, but inside that window it can be
staler than the next admitted transfer — a hit may report `admissible` for a call
a fresh simulation would block.

Every hit says so on the verdict itself, in optional fields that are **absent on
a fresh decision** and are never part of the cache key or equality:

| Field | Type | Meaning |
| --- | --- | --- |
| `cached` | `true` | The verdict was served from the cache. Absent on a fresh simulation. |
| `observedLedger` | `number` | The ledger the cached verdict was computed against. |
| `ageMs` | `number` | Time elapsed since the verdict was stored, in milliseconds. Each hit reports its own age; earlier hits are not rewritten. |

An agent loop can therefore decide per call: accept `ageMs` under its own
threshold, or pass `forceFresh: true` before a high-value transfer. Existing
consumers see exactly the fresh-decision shape they saw before the fields
existed.

## Methods

### `check(call: ContractCall): Promise<PreFlightDecision>`

Evaluates a contract call against the guard without throwing or broadcasting.

Every failure it surfaces is a typed guard error. Invalid caller input rejects
with `InvalidInputError` before any RPC (unwrapped). Any other throwable from the
enforcement path — a custom `Clock`, an injected server, a mapper — never escapes:
it becomes the fail-closed `undetermined` verdict with a `GuardError` whose
`cause` is the original value (a `GuardUndeterminedError` when the pipeline had
not already classified the failure). The verdict is never upgraded to
`admissible`.

### `warmCache(calls: ContractCall[], options?): Promise<WarmCacheSummary>`

Runs each call through the same `check()` path to populate the opt-in cache
deliberately — for example after a policy install or a restart — and returns
`{ attempted, cached, blocked, undetermined, durationMs }`. It stores only the
cacheable `admissible`/`blocked` verdicts, respects the same `maxEntries`, TTL and
policy revision, and reports a blocked or undetermined call instead of throwing.
With `cache` omitted, nothing is stored and `cached` is `0`. Warming is an
optimization, not a guarantee: verdicts can be stale or evicted before use, and
another process does not share this cache.

### `invalidate(call?: ContractCall): void`

Clears all cached decisions, or only the entries for the supplied call.

### `assertAllowed(call: ContractCall): Promise<PreFlightDecision & { allowed: true }>`

Evaluates a call and returns the decision if admissible, or throws `GuardBlockedError` if blocked and `GuardUndeterminedError` if undetermined or on transport failure. Raw transport errors never escape.

### `checkBatch(calls: ContractCall[], options?: CheckBatchOptions): Promise<PreFlightBatchDecision>`

Evaluates a sequence of calls with the guard's all-or-nothing semantics. Every
call is simulated independently, and positive SAC transfer amounts are staged
against the rolling `window_cap`. A call that passes alone but would push the
cumulative staged spend over the cap is reported as `blocked` with reason
`window_cap_exceeded`; a refusal or undetermined result from any member makes
the batch inadmissible.

Staging state is fail-closed:

- `options.initialWindowSpent` (including an explicit `0n`) is a trusted caller
  snapshot and avoids the ledger read.
- An absent `Window` ledger entry means zero committed spend, not a failed read.
- A failed policy or window RPC read leaves the state unknown. When a positive
  transfer needs that state, the affected verdicts are `undetermined` and the
  batch `kind` is `undetermined`; the SDK never stages against an assumed zero.
- The returned `staging` field records the snapshot: `source` is
  `provided | ledger | absent | unavailable`, `windowSpent` is `null` when
  required state could not be read, and `unavailable` says whether staging was
  blocked. It is omitted for an empty batch or when no snapshot was resolved.

Non-transfer calls and policies with a zero cap do not require the window
snapshot and are unaffected by an unavailable read.

### `assertBatchAllowed(calls: ContractCall[], options?: CheckBatchOptions): Promise<PreFlightBatchDecision & { admissible: true }>`

The throw-on-refusal form: returns the batch decision if all calls are admissible, or throws `GuardBlockedError` for the first blocked
member, or `GuardUndeterminedError` for an undetermined member, an
unavailable staging state, or transport failure.

## SAC transfer helpers

`checkTransfer()` and `checkTransferFrom()` build the two SAC calls most
integrations guard and run them through the ordinary `check()` path. Building
the `ContractCall` by hand is where argument order and `i128` encoding go
wrong, so the helpers own both: `transfer` is `[from, to, amount]` and
`transfer_from` is `[spender, from, to, amount]`.

Both validate their input synchronously, before any RPC, and throw
`InvalidInputError` for a malformed token/spender/from/to address or a lossy
amount (a non-safe-integer `number`, a negative value, or one outside the
`i128` range). The verdict is the same `PreFlightDecision` `check()` returns,
including its fail-closed `undetermined` arm.

```ts
import { checkTransfer } from "stellar-agent-guard-sdk";

const decision = await checkTransfer(
  { server, networkPassphrase, guard, agent, source },
  {
    token: USDC_SAC,   // C...
    from: GUARD,       // G... (the guarded account)
    to: RECIPIENT,     // G... or C...
    amount: 1_001n,    // bigint in the token's smallest unit
  },
);
// decision.kind: "admissible" | "blocked" | "undetermined"
```

```ts
try {
  const decision = await checkTransferFrom(
    { server, networkPassphrase, guard, agent, source },
    {
      token: USDC_SAC,
      spender: SPENDER, // allowance owner / first argument
      from: GUARD,
      to: RECIPIENT,
      amount: 1_001n,
    },
  );
} catch (error) {
  // InvalidInputError — thrown before any RPC, never an undetermined verdict.
}
```

For repeated checks, build the call once and reuse an interceptor:

```ts
import { buildTransferCall, PreFlightInterceptor } from "stellar-agent-guard-sdk";

const interceptor = new PreFlightInterceptor({ server, networkPassphrase, guard, agent, source });
const call = buildTransferCall({ token: USDC_SAC, from: GUARD, to: RECIPIENT, amount: 1_001n });
await interceptor.check(call);
```

## Simulation fidelity: decision table

Pre-flight is a prediction made against one ledger snapshot. The four gaps
below are every limitation the SDK documents, plus the opt-in cache's
staleness caveat; each row names what can differ, the function that mitigates
it, the test that pins that mitigation, the residual risk, and what to do
instead. **None of these gaps is a capability the SDK claims to fix.**

The verdict boundary is part of the contract: `InvalidInputError` is thrown
before any RPC, everything the enforcement pipeline can throw is converted to a
fail-closed `undetermined` verdict carrying a typed guard error (with the
original value on `cause`), and no other throwable escapes `check()`.

| Gap | What can differ | Mitigation (code + pinning test) | Residual risk | What to do instead |
| --- | --- | --- | --- | --- |
| **1. Window state moves** between `check` and broadcast | Another spender consumes the rolling window after the simulation, so an `admissible` transfer is refused on-chain. | `check()` never broadcasts; [`enforceCall()`](../../src/invoke.ts) runs the real `__check_auth` against live state. Under `invoke()`, [`withAccountQueue()`](../../src/invoke.ts) serializes fetch → build → submit per source account (pinned by “serializes concurrent calls and gives each transaction a distinct sequence” in [invoke.test.ts](../../tests/unit/invoke.test.ts)); a post-inclusion refusal is still reported `blocked` with `charged: true` (pinned in [invoke-dry-run.test.ts](../../tests/unit/invoke-dry-run.test.ts)). | **Unfixable client-side.** A spender outside this SDK's queue, or one using a different source account, can move the window after the verdict. | Treat `admissible` as advisory; rely on the on-chain refusal, and route all spend from the account through one process/queue. |
| **2. Fee market moves** | The inclusion/resource fee at broadcast differs from the quote (surge pricing, base-fee change), producing `txInsufficientFee` or a different real price. | The quote comes from the same enforced simulation that produced the verdict ([`CostPreChecker` / `costOf()`](../../src/cost.ts)); [`feeBreakdown()`](../../src/tx.ts) uses the same `INCLUSION_FEE` the envelope declares; min-fee broadcast rejections retry with a bounded fee bump (`invoke()`'s `feeBump` in [invoke.ts](../../src/invoke.ts)). Pinned by the `feeBreakdown`/`feeSource` suites in [cost.test.ts](../../tests/unit/cost.test.ts) and the fee-bump lifecycle in [invoke.test.ts](../../tests/unit/invoke.test.ts). | **Unfixable client-side.** Fees are dynamic; `maxFeeStroops` is a pre-flight ceiling, not a network guarantee, and a fee bump changes the price you pay. | Budget for the ceiling, not the quote; use `feeBump` for min-fee rejections and `onRetry` to observe them. |
| **3. Simulation does not execute** | Simulation rolls back its writes, and cannot reveal effects that depend on a return value or on state another call would have produced (oracle price, swap quote, mid-transaction balance). | The enforced simulation runs the real `__check_auth` ([`enforceCall()`](../../src/invoke.ts)), and refusals are recovered from diagnostics by [`reasonFromDiagnosticEvents()`](../../src/invoke.ts) and [`decodeAuthDecision()`](../../src/events.ts). Pinned by the guard-block tests in [invoke.test.ts](../../tests/unit/invoke.test.ts) and the `decodeAuthDecision` suite in [events.test.ts](../../tests/unit/events.test.ts). | **Unfixable client-side** — it is inherent to simulation. Such a call can be `admissible` pre-flight and still behave differently on-chain; only the decision event is observable, not the call's return value. | Verify return-value-dependent behaviour after inclusion (events/balances), and guard the *next* call rather than assuming the first one's effect. |
| **4. Batch semantics are approximated** | [`checkBatch()`](../../src/preflight.ts) simulates each call in sequence with staged window accounting; it is not an atomic batch. State mutations between calls other than guard window spend are not observed, intra-batch window expiry is not modelled, and `totalEstimatedResourceFee` is a sum of per-call estimates. | [`checkBatch()` / `preflightBatch()`](../../src/preflight.ts) stage positive SAC transfer amounts and report `window_cap_exceeded` for a call that passes alone but pushes cumulative spend past the cap. Pinned by the staged-batch tests in [preflight.test.ts](../../tests/unit/preflight.test.ts). | **Unfixable client-side.** Atomicity and intra-batch state cannot be reproduced by sequential simulations. | Use the batch verdict for destructive pre-screening only; keep the on-chain all-or-nothing auth check as the decision. A contract-side `check_batch` is the intended fix. |
| **Cache staleness** (opt-in) | A cached `admissible` can be staler than one admitted transfer: the window or policy can change while the verdict is reused. | Cache entries are keyed on ledger + policy revision, capped at one ledger-close TTL, dropped when the ledger advances, and cleared by `invalidate()` ([preflight.ts](../../src/preflight.ts)). Pinned by “PreFlightInterceptor simulation cache” in [preflight.test.ts](../../tests/unit/preflight.test.ts). | Bounded by the TTL (and by the supplied `policyRevision`), never eliminated. | Leave caching off when a stale verdict is unacceptable; otherwise supply `policyRevision` and invalidate after policy/account-state changes. |

## CheckResult decoding and fallback behavior

The interceptor reads the guard contract's `CheckResult` value from the
simulation response. The contract returns an enum with the following shapes:

- `Allowed` — a unit variant with no payload.
- `Blocked(reason)` — a variant carrying a symbol reason (e.g. `recipient_not_allowed`,
  `per_tx_cap_exceeded`, `paused`).

`decodeCheckResult` accepts either the raw `xdr.ScVal` the contract returns
(for example `simulation.returnValue`) or the native value `scValToNative`
produces from it, and validates a `Blocked` reason against the contract's own
reason vocabulary.

Decoding is fail-closed. If the returned ScVal is not a recognized
`CheckResult` shape — an unknown enum tag, a `Blocked` reason the contract does
not define, an empty or over-long `ScVec`, a blocked variant whose reason is not
a symbol, or a non-`ScVec` input — the decoder does not throw. Instead it
returns the typed fallback for the call-site contract:

| Call site | Fallback verdict | Notes |
| --- | --- | --- |
| `PreFlightInterceptor.check` | `undetermined` with `null` reason | The caller sees a typed decision, not an exception. |
| `assertAllowed` | `GuardUndeterminedError` | When `CheckResult` cannot be decoded, `assertAllowed` throws `GuardUndeterminedError` with cause preserved. |

In other words, a malformed or future `CheckResult` never escapes to the agent
loop as a raw throw. The interceptor treats any decode failure as
`undetermined`, which is the fail-closed result.
