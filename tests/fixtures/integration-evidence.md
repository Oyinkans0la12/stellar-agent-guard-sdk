# Live integration evidence — Phase 2

Record of the enforcement suite running against the real Phase 2 testnet
instance. Reproduce with `npm run test:integration` (requires `.env.phase2`).

**Last verified**: September 2026 (feat/integration-harness-and-guardpolicy-types)
**Attempted** (feat/cost-issues-448-451, 2026-11-24): `npm run test:integration`
matched the Phase 1 artifact identity, then stopped while funding the ephemeral
test fixture because Friendbot returned HTTP 400. No live scenarios ran, so this
attempt does not replace the recorded successful scenario evidence below.
**Note**: Type guard validation refactoring in `src/policy.ts` does not change enforcement behavior; evidence remains valid.
**Note** (feat/policy-readonly-deep-freeze): Added `DeepReadonly`/`ReadonlyPolicyConfig`/`freezePolicy` — type and freeze boundary change only; no enforcement logic altered. Evidence remains valid.
**Note** (feat/policy-304-return-actionable-paths-for-invalid-policy-encoding-inputs, PR for #304): `policyToScVal()` now validates a policy draft before constructing any `ScVal` and throws `PolicyValidationError` with a path-friendly message when the draft is invalid; policy enforcement behavior remains unchanged. Evidence remains valid.

**Note** (feat/preflight-334-335-coalesce-and-batch-bounds, PR for #334/#335): Adds in-flight coalescing for concurrent identical `check()` calls and batch-wide `signal`/`deadlineMs` handling on `checkBatch()`. It is an enforcement-path change but does not alter the contract-side block decision; the live Phase-2 scenarios remain the correct proof for the actual guard outcome.

**Note** (feat/sdk-295-298-signer-identity-retry-metadata-deadline, PR for #295/#296/#297/#298): Adds signer-identity validation at the `AgentSigner` boundary, public-boundary validation of retry/metadata fields, and typed deadline handling. It is a boundary validation path and does not change the block decision itself.

**Note** (fix/336-339-preflight-heartbeat-hardening, PR for #336): `checkBatch()` now distinguishes an explicitly supplied `initialWindowSpent` snapshot from a failed ledger read. When a positive transfer needs the staging state, a failed live read is treated as unavailable rather than zero; this still preserves the fail-closed behavior captured in the live scenarios above.

**Note** (feat/25-tx-fee-bump-on-min-fee, PR #171): Adds a bounded fee-bump retry when broadcast is rejected for being below the network minimum fee. The retry re-prepares the transaction and re-simulates it, but the guard block decisions used for this evidence remain valid. See the recorded live scenario output below.

**Note** (feat/issue-39-feat-policy-decodecheckresult-exhaustive-tests, PR #229): `decodeCheckResult` is now total and fail-closed — an unknown enum tag, a `Blocked` reason the contract does not define, or a malformed payload are all classified as a typed failure instead of being misreported. This does not alter the guard's block decision path.

**Note** (feat/issue-114-feat-tx-abortsignal-timeout-support-for-check, PR #235): Adds caller-owned cancellation to the enforcement pipeline: an optional `signal`/`timeoutMs` on `check()`, `invoke()`, and `checkBatch()`. Only RPC timeout and abort semantics are affected; blocked/admissible policy outcomes are unchanged.

**Note** (feat/sdk-260-282-285-311, PR for #311/#282/#285/#260): The only enforcement-path file touched is `src/policy.ts`, and only on the encode/decode edges: `policyToScVal` now emits the current contract ABI, while `decodePolicy` accepts the contract's more permissive representations. It does not affect the live enforcement logic for blocks or admits.

**Note** (feat/sdk-260-282-285-311 — deployment prerequisite, verified 2026-10-21): Reproducing `npm run test:integration` **from this branch requires redeploying the Phase-2 instance first** (`phase2-instance.json` is part of the evidence record, not a lockstep with an old deployment). This note simply records the maintenance requirement; the policy behavior below is unchanged.

**Note** (feat(preflight)/preflight-verify-assertallowed-throws-guardblockederror-only-never-transport-errors, PR for #90): Formalizes and pins the `assertAllowed` and `assertBatchAllowed` throw-on-refusal contract, ensuring policy blocks throw `GuardBlockedError` and undetermined / transport errors throw `GuardUndeterminedError` with root cause preserved. The underlying on-chain simulation and policy enforcement evaluation remain unchanged; live Phase 2 integration evidence remains valid.

**Note** (security/issue-117-feat-telemetry-injectable-transport-custom-rpc, PR #373 for #117): `src/preflight.ts` and `src/invoke.ts` now take the shared `{ server? | url? }` transport config (`src/transport.ts`). The only new code on the enforcement path runs at the public boundary: it resolves the `rpc.Server` (an injected instance verbatim, or `new rpc.Server(url, rpcOptions)`) and throws `InvalidInputError` when both or neither are supplied, before any RPC. Simulation, signing, broadcast and the guard's block/admit decision are unchanged, so the scenario evidence below remains valid. A live re-run was attempted on 2026-10-24 against a freshly deployed instance (`npm run deploy:phase2`). It stopped at `set_policy` with `HostError: Error(Object, UnexpectedSize)`: the Phase-1 WASM does not decode the current `policyToScVal` ABI, which is the redeploy prerequisite recorded above. That deploy also showed `initialize` failing with `txBadAuthExtra` when the same key is both `source` and an `accountSigners` entry, reproduced on `main`; that is out of scope for this PR and is not fixed here. No scenario output from that attempt is recorded here.

**Note** (feat/invoke-fee-cap-batch-deadline-diagnostics-reason-table, PR for #419/#411/#407/#406): `src/invoke.ts` adds an optional `maxFeeStroops` ceiling checked after the enforced simulation and before broadcast (over-budget calls stay local and unbroadcast), and `src/preflight.ts` now enforces `checkBatch()`'s `deadlineMs` as one fail-closed budget and exposes `simulateForDiagnostics()` without producing a verdict. These are local safety and observability bounds around the existing pipeline: the contract-side block/admit decision, the enforced simulation and the signed authorization entry are unchanged, so the five live scenarios recorded below remain valid. No fresh live run was performed for this change.

**Note** (feat/onverdict-cache-provenance-error-tojson, PR for #408/#409/#477): `src/preflight.ts` now reports cache provenance on a pre-flight verdict (`cached`, `observedLedger`, `ageMs`), accepts `forceFresh` to bypass the opt-in cache for one call, and emits each final verdict once to an observability-only `onVerdict` hook (cached, coalesced and fail-closed paths included). The hook is invoked after the verdict is fixed and cannot change it, and caching/`forceFresh` only select whether the existing simulation runs — the contract-side block/admit decision is unchanged. In `src/invoke.ts` the only change is a JSON-safe `toJSON()` on `InvokeRetryError` for structured logging. The five live scenarios recorded below remain the correct proof; no fresh live run was performed for this change.

## Instance under test

| | |
| --- | --- |
| Guard (custom account) | `CAPADGEK457RHKN4RYVUMDJTFHDSG7R5HREQONKLYK7MFKC5WFENPP44` |
| Token (SAC) | `CDCYDGBGS5AZ5BZS6XY2SK2PHJHSOEGTN3N4INCK34KF6GU2BGC7Z6MB` |
| Network | Test SDF Network ; September 2015 |
| Deployed WASM SHA-256 | `f47919f92e78fdd034836aa61955fc338dd56a218c448c37df1867a8c3da0f63` |
| Same artifact as Phase 1 | yes — verified against the ledger's `ContractExecutable` and the SHA-256 of the fetched bytecode |

**Note** (fix/policy-293-avoid-freezing-caller-owned-policy-objects, PR for #293): `freezePolicy()` no longer freezes the caller's policy object in place; it returns a deeply frozen **copy** — the policy object, `assets`, `recipients`, `protocols` (each rule and its `fns` array), `recipient_window_caps` (each entry) and `blocked_recipients` are copied before freezing. The change is confined to an ownership/immutability helper on the policy model: it copies and freezes, it does not add, drop, normalise or validate any field, and the `ScVal` produced by `policyToScVal` is byte-identical to the one produced for the same policy before this change. The five scenarios recorded below are enforced by the contract during simulation and are unchanged; the new ownership semantics are covered by unit tests in `tests/unit/policy.test.ts`. No fresh live run was performed for this change; the recorded results remain valid for these scenarios.

This is **not** the Phase 1 instance. Phase 1's guard (`CAYJZT4X…`) is left frozen
by its own dead-man switch as Phase 1's evidence, and is never touched by this
suite. See `phase2-instance.json` for the deployment record.

Live policy the suite runs against and asserts on:

```
per_tx_cap 1000, window_cap 150, window_secs 60,
assets [token], recipients [allowlisted recipient], allow_any_recipient false,
protocols [], paused false, dms_grace_secs 0
```

## What counts as evidence for a block

A guard block happens in enforced pre-simulation, **before broadcast**. It
therefore cannot have a transaction hash — that is the entire point of the
pre-flight path, so demanding a hash for a blocked action would be a demand for
fabricated evidence. The evidence for a block is:

1. the contract's own `event_auth_checked, blocked, <reason>` event, taken from
the failed enforced simulation's diagnostics — signed by the contract, not
inferred from a generic failure;
2. the specific `BlockReason` from `src/reasons.ts`;
3. no submission at all (the result carries no hash), and
4. no state movement — the SAC balance and the rolling-window entry are read
before and after and must be unchanged.

Asserting only "it failed" would also pass for a contract trap, a missing
trustline, or a fee error, so the suite asserts all four.

## Run output

```
[live] guard CAPADGEK457RHKN4RYVUMDJTFHDSG7R5HREQONKLYK7MFKC5WFENPP44
[live] per-tx cap 1000, rolling window 150/60s, 1 allowlisted recipient(s)
[allowed] tx f8f5b3c51b85c8777c956d71330d015fcf72fa57548077d8b32969f8ba9c762e at ledger 4704849
  ✔ allows a transfer inside both caps, with a real on-chain hash (12192.988915ms)
[blocked] per_tx_cap_exceeded (1001 > 1000)
  ✔ blocks a per-transaction-cap violation, pre-broadcast (8519.903622ms)
[rolling] 76 + 76 = 152 > window_cap 150
  ✔ blocks a rolling-window-cap violation that only accumulation can explain (12667.333992ms)
[blocked] recipient_not_allowed (GDZOKF3HGA6XSKIEEPJC5ANON3IJ5OGZMCX7GEGJLZN7JFRKOO4N2HXM)
  ✔ blocks a recipient-allowlist violation (5238.482785ms)
[blocked] paused (account-state refusal)
  ✔ distinguishes an account-state refusal from a policy refusal (9390.520814ms)
✔ live enforcement: SAC transfer (48594.535501ms)
ℹ tests 5
ℹ pass 5
ℹ fail 0
```

## Scenario by scenario

### 1. Allowed transfer

`transfer` of 50 from the guarded account to the allowlisted recipient, authorized
by the agent key through `__check_auth`.

- real transaction `f8f5b3c51b85c8777c956d71330d015fcf72fa57548077d8b32969f8ba9c762e`
- landed in ledger `4704849`, re-read from the RPC and confirmed `SUCCESS`
- the guarded account's SAC balance decreased by exactly 50
- the rolling window recorded exactly 50

### 2. Per-transaction-cap violation

`transfer` of **1001** against a `per_tx_cap` of 1000.

- outcome: `blocked`, reason `per_tx_cap_exceeded`
- no transaction hash exists (nothing was broadcast)
- the contract emitted, in the failed enforced simulation:

```
[Failed Contract Event (not emitted)] contract:CAPADGEK…,
  topics:[event_auth_checked, blocked, per_tx_cap_exceeded], data:{}
```

- balance and window unchanged

### 3. Rolling-window-cap violation

Two `transfer` calls of **76** each, each individually admissible (below both the
1000 per-tx cap and the 150 window cap). Their sum, 152, exceeds the window cap of
150 — so the block can only be explained by genuine accumulation.

- first transfer: allowed; window went from 0 to 76
- second transfer: `blocked`, reason `window_cap_exceeded`
- emitted `topics:[event_auth_checked, blocked, window_cap_exceeded]`
- balance and window remained at the post-first-transfer values

The amounts are derived from the live policy (`window_cap / 2 + 1`) rather than
hardcoded, and the test asserts each is individually admissible — otherwise it
could pass by tripping the per-tx cap instead.

### 4. Recipient-allowlist violation

`transfer` of 10 to an address not in the policy's `recipients` list, with
`allow_any_recipient: false`.

- outcome: `blocked`, reason `recipient_not_allowed`
- emitted `topics:[event_auth_checked, blocked, recipient_not_allowed]`
- balance unchanged

### 5. Account-state refusal is distinguishable

With `paused: true`, a transfer is refused with `paused` — an account-state
reason, not a spend violation. This matters because the two need different
responses: a spend violation is the guardrail working, a pause is the operator
speaking. The test restores the policy afterwards and asserts it was restored.

## A stale-ledger failure this suite found

The first runs of scenario 3 failed intermittently, and not because of policy: a
transfer passed enforcement, was **included**, and was then rejected by core with:

```
error, scecExceededLimit
data: ["operation byte-write resources exceeds amount specified", "724", "652"]
```

Six back-to-back transfers in a closed window produced:

| window entries before | simulation declared `write_bytes` | ledger charged | outcome |
| --- | --- | --- | --- |
| 0 | 652 | 652 | allowed |
| 1 | 652 | 724 | **error** |
| 1 | 724 | 724 | allowed |
| 2 | 724 | 796 | **error** |
| 2 | 796 | 796 | allowed |
| 3 | 796 | 868 | **error** |

Every declared value is exactly one rolling-window entry (72 bytes) short
whenever the simulation observed state from before the previous transfer's commit.
Waiting for the ledger to advance past the previous write fixed 6 of 6 runs,
confirming the cause: the enforced simulation priced the transaction against a
ledger snapshot that predated the write the SDK had just made.

At the time of this recorded run, the SDK fix was a single bounded retry, gated
on this specific failure (`isStaleLedgerResourceFailure`). It is safe because a
transaction rejected for exceeding a resource limit applies nothing, and
inclusion proves the ledger has since advanced. It is deliberately *not* applied
to `Auth` failures — those are the guard refusing, and retrying a block would be
wrong. Re-running the same six transfers returned 6 of 6 allowed with no waits.
The retry-hardening change in this branch preserves that safety boundary while
making the retry budget and backoff explicit.

This is worth stating plainly rather than burying: it is a client-side resource
pricing issue, not a guard defect, and it did not let any transaction through that
policy forbade.

## Addendum — 2026-10-21 (PR: cache bounded verdicts + RPC shape contracts on `src/preflight.ts`)

Recorded because this PR touches the enforcement path (`src/preflight.ts`) and CI's
`enforcement-path evidence gate` therefore requires this file in the diff.

**It is not accompanied by a fresh live-testnet run**: `.env.phase2` is absent
from this contributor checkout, so `npm run test:integration` cannot execute here.
No fresh Phase-2 transcript is claimed below. The CI gate verifies only that this
file was touched — not the numbers — and the same limitation stated in the addenda
above applies here unchanged.

### What the PR changes on the enforcement path

- `src/preflight.ts`: adds a bounded verdict cache with LRU eviction, entries keyed
  by the call fingerprint and policy revision token, and a ledger-aware TTL that is
  capped to one close interval so the cache never crosses a ledger boundary.
- `src/preflight.ts`: keeps distinct `undetermined`/`blocked`/`admissible` verdicts
  and does not silently turn an undetermined outcome into a cached allow.
- `src/preflight.ts`: preserves RPC-bound timeout semantics and fail-closed handling
  for aborts and malformed simulation resource fees, while still reporting the
  same `PreFlightDecision` shape the guard contract and adapters already expect.
- This is a read-only cache and correctness-boundary change, not a change to the
  contract's real block decision or to the live guard semantics exercised by the
  Phase-2 suite above.

### What did run locally

```text
npm run typecheck
npm run lint
npm test
npm run build
npm run test:smoke
npm run test:exports
```

Those checks cover the repo's guardrail logic, the export surface, and the packaged
consumer path; they are valuable, but they are not a substitute for the Phase-2
live suite. A maintainer with `.env.phase2` should run `npm run test:integration`
against this branch before merge and replace this addendum with the fresh run
output if desired.

No credentials, deployment, or policy change are needed beyond what the suite
already does.

## Addendum — 2026-10-22 (PR: pending invoke outcome + telemetry observability on `src/invoke.ts`)

Recorded because this PR touches the enforcement path (`src/invoke.ts`) and CI's
`enforcement-path evidence gate` therefore requires this file in the diff.

**It is not accompanied by a fresh live-testnet run**: `.env.phase2` is absent
from this contributor checkout, so `npm run test:integration` cannot execute here.
No fresh Phase-2 transcript is claimed below. The CI gate verifies only that this
file was touched — not the numbers — and the same limitation stated in the addenda
above applies here unchanged.

### What the PR changes on the enforcement path

- `src/invoke.ts`: adds a `pending` outcome (`InvokePendingOutcome`) for a
  transaction the network accepted but did not confirm within the polling
  budget. It is reported as neither success nor failure: it carries the
  transaction hash, the `SubmissionResult`, and explicit guidance not to
  rebroadcast without first querying status, so an in-flight transaction can no
  longer be mistaken for a failed one and accidentally executed twice.
- `src/heartbeat.ts`: classifies that same `pending` outcome once through
  `onError` as a typed non-beat, without advancing `lastBeatAt` or the
  same-second dedupe marker — the same treatment already given to `blocked`,
  `error` and `dry_run`.
- `src/telemetry.ts`: isolates a committed event whose topic/data XDR fails to
  decode to that single event (counted, never delivered), and makes the count
  observable through `onMalformed`/`onMalformedEvent`. Also honors a pre-aborted
  `signal` before every startup request and retries a failed startup
  `getLatestLedger` inside the existing bounded, abort-aware envelope.

### What did not change

- No guard-policy decision path, authorization-entry construction, signing, or
  `__check_auth` classification logic was modified. `blocked` and `admissible`
  verdicts, and the enforced-simulation invariant, are untouched.
- `src/tx.ts`, `src/policy.ts` and the pre-flight enforcement pipeline are
  unchanged by this PR.
- The new `pending` arm is reached only after the enforced simulation has
  already passed and the transaction has been broadcast — it cannot turn a
  refusal into a pass, and it never reports `allowed`.

### What did run locally

```text
npm run typecheck
npm run check:strict-ratchet
npm run lint
npm run format:check
npm test
npm run test:coverage:floor
npm run build
npm run test:browser
npm run check:secrets
node scripts/check-enforcement-evidence.ts --check-structure
```

As above, these are valuable but are not a substitute for the Phase-2 live
suite. A maintainer with `.env.phase2` should run `npm run test:integration`
against this branch before merge.

## Addendum — 2026-10-22 (PR: policy validation and comparison, issues #306–#308)

This PR touches `src/policy.ts`, so the enforcement-path evidence file is included
as required. The policy validator now rejects values beyond the contract's
`i128`/`u64` wire maxima; the address comparison key and duplicate-tolerant diff
are client-side validation/display behavior and do not alter the contract's
authorization decision.

**The live suite did not reach its enforcement scenarios.** `npm run test:integration`
used the documented default ephemeral deployment, deployed a SAC and guard, then
failed during `initialize` with `txBadAuthExtra`. No fresh live enforcement
result is claimed. The generated ephemeral environment file was removed after
the failure. A maintainer should rerun the live suite successfully before merge.

### What did run locally

```text
npm run typecheck
npm run lint
npm test
node --import tsx --test tests/unit/policy.test.ts tests/unit/policy-schema.test.ts tests/unit/policy-diff.test.ts
```

The full unit suite passed; these offline checks do not substitute for the
missing live-testnet scenarios above.

## Addendum — 2026-10-25 (PR: agent-runtime guide, default policy, reason tests, simulation concurrency; issues #74, #59, #54, #40)

This PR touches `src/policy.ts` (adds the frozen `DEFAULT_GUARD_POLICY` constant;
no validation, encoding or decision logic changes) and `src/preflight.ts` (a
concurrency limit and a bounded HTTP 429 retry around the existing
`enforceCall` — the verdict classification itself is unchanged), so the
enforcement-path evidence file is included as required.

**The live suite was not run for this change.** The author has no funded
`.env.phase2` testnet credentials, so `npm run test:integration` was not executed
and no fresh live enforcement result is claimed. The one behavioural change
reachable live is that at most four simulations per interceptor are in flight at
once (default), which can only delay a verdict, never alter it. A maintainer with
`.env.phase2` should run the live suite against this branch before merge.

### What did run locally

```text
npm run typecheck
npm run lint
npm run format:check
npm test
npm run test:types
npm run build && npm run test:exports && npm run test:pack
node scripts/check-doc-links.ts
```

The offline checks above passed; they do not substitute for the live-testnet
scenarios.

## Addendum — 2026-11-25 (PR: `waitForTransaction`, `onRetry`, SAC transfer helpers, fidelity table; issues #416, #415, #410, #414)

This PR touches `src/tx.ts` (`waitForTransaction` — a new polling helper that
only reads `getTransaction`; it never signs or broadcasts) and `src/invoke.ts`
(the `onRetry` callback, invoked after the pipeline has already classified a
retryable broadcast failure — it observes the retry, it does not change whether
one happens). It also adds `src/transfer.ts` (SAC call builders plus their
checking wrappers over the existing interceptor; no new decision logic) and a
documentation table. The enforcement-path evidence file is included as required.

**The live suite was not run for this change.** The author has no funded
`.env.phase2` testnet credentials, so `npm run test:integration` was not executed
and no fresh live enforcement result is claimed. None of the changes alter the
guard's block/admit decision: the new code reads transaction status after
submission, reports retries the pipeline already performed, and builds the
transfer calls the existing interceptor already checks. A maintainer with
`.env.phase2` should run the live suite against this branch before merge.

### What did run locally

```text
npm run typecheck
npm run lint
npm run format:check
npm test
npm run test:coverage:floor
npm run build
npm run check:bundle-size
node scripts/check-doc-links.ts
```

The offline checks above passed; they do not substitute for the live-testnet
scenarios.

## Addendum — 2026-11-25 (PR: invoke queue observability, fee ceiling, preflight warmCache and typed failures; issues #423, #418, #413, #412)

This PR touches `src/invoke.ts` and `src/preflight.ts`:

- `onQueue` / `invokeQueueStats()` observe the existing per-source-account
  queue. They add no new ordering, signing or RPC work: the queue semantics are
  unchanged, and a throwing hook is swallowed.
- `feeBump.maxInclusionFee` compares a fee-bump retry's already-computed
  inclusion fee with a caller ceiling. A breach returns an `error` outcome
  carrying `FeeCapExceededError` and never broadcasts the over-cap transaction;
  it cannot turn a guard refusal into an approval.
- `warmCache()` runs calls through the same `check()` path to populate the
  opt-in cache. It stores only `admissible`/`blocked` verdicts, exactly as a
  normal check does.
- `check()` now converts an unexpected non-`GuardError` throw into the
  fail-closed `undetermined` verdict with the original value on `cause`.
  `InvalidInputError` stays unwrapped, and the verdict is never `admissible`.

**The live suite was not run for this change.** No `.env.phase2` credentials
were available, so `npm run test:integration` was not executed and no fresh live
enforcement result is claimed. None of the changes alter the guard's
block/admit decision; the recorded Phase-2 scenarios remain the contract-side
proof for that decision. A maintainer with `.env.phase2` should run the live
suite against this branch before merge.

### What did run locally

```text
npm run typecheck
npm run lint
npm run format:check
npm run check:strict-ratchet
npm run test:types
npm test
npm run test:coverage:floor
npm run build
npm run test:exports
node scripts/check-doc-links.ts
node scripts/check-enforcement-evidence.ts --check-structure
```

The offline checks above passed; they do not substitute for the live-testnet
scenarios.
