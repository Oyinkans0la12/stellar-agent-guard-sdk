# Troubleshooting

Use the symptom text or outcome below as a search term. The SDK fails closed: an
`undetermined` result or adapter mapping failure does not mean the guard approved
the action.

| Symptom to search for | Likely cause | Fix |
|---|---|---|
| `kind: "undetermined"` during an RPC outage, rate limit, or `RPC call during '…' exceeded timeout of …ms` | The simulation could not produce a trustworthy verdict because the RPC is unavailable, throttling, or slower than the request budget. | Confirm the configured RPC endpoint/network and reduce caller-generated RPC pressure with application-level scheduling. There is no SDK `concurrency` option. Set `timeoutMs` on `PreFlightInterceptor.check()` (or adapter `timeoutMs`) to bound each RPC; `invoke()` also accepts `deadlineMs` for a whole-pipeline budget. A timeout bounds SDK waiting, not necessarily the already-sent RPC. |
| `sequence_number_collision` or a submitted transaction rejected for a bad sequence | Another process or code path submitted from the same fee-paying `source` account while this invocation was building, or the RPC returned a stale sequence snapshot. | `invoke()` serializes transactions per source account within one process. Route all same-account submissions through that queue; across processes or other SDKs, add a shared sequence coordinator or use separate fee-paying accounts. Local serialization cannot coordinate external broadcasters. See [invoke pipeline](api/invoke-pipeline.md). |
| `kind: "blocked"` with a `reason` such as `paused`, `heartbeat_expired`, `per_tx_cap_exceeded`, or `recipient_not_allowed` | This is a policy/account refusal, not an RPC failure. For example, `paused` is the admin kill switch; `heartbeat_expired` means the dead-man grace elapsed; `per_tx_cap_exceeded` means the transfer exceeded its per-transaction cap; `window_cap_exceeded` means rolling spend is over budget. | Read the exact reason with `explainReason(reason)` or `reasonMessagesEn[reason]`; the latter includes operator remediation. Check the full [SDK reason glossary](api-reference.md#reason-messages-issue-96) and the [contracts-side operator reason glossary](https://github.com/Stellar-Agent-Guard/stellar-agent-guard-contracts/blob/main/docs/reason-glossary.md). |
| `heartbeat_expired` / `admin_frozen` or `dmsUrgency(...) === "expired"` | The dead-man grace elapsed, or an administrator froze the account. `dmsUrgency()` is display guidance; it does not unfreeze or authorize anything. | Start and monitor `startHeartbeat()` at an interval no greater than one third of the configured grace window. Use `dmsUrgency()` and `DMS_WARN_RATIO_DEFAULT` to surface the countdown. An admin must perform the [contract unfreeze procedure](https://github.com/Stellar-Agent-Guard/stellar-agent-guard-contracts/blob/main/docs/functions/freeze-unfreeze.md); the SDK exposes `submitUnfreeze()`. Resume heartbeats after unfreezing. |
| `call mapping failed before enforcement` or `the langchain adapter's call mapper threw` | The adapter's `toContractCall` mapper threw (often a typo in the mapped contract/function/arguments) before the guard could check the action. For example: `call mapping failed before enforcement: the langchain adapter's call mapper threw: Cannot read properties of undefined`. | Correct the mapper and its inputs. Adapter mapping failures halt execution as `undetermined`; the wrapped tool does not run. Use the exact `toContractCall` option name (or `toContractCalls` for a batch); see [framework adapter options](api/framework-adapters.md). |
| `kind: "over_budget"` | The estimated total fee (resource fee plus inclusion fee) exceeds `maxFeeStroops`. | Raise the `CostPreChecker` ceiling only if the operator's budget permits it. `maxFeeStroops` accepts a non-negative `bigint` or base-10 integer string; omission means no fee ceiling, while `0n` / `"0"` is a real zero-stroop ceiling. A per-call ceiling overrides the configured one. This is a pre-flight estimate, not a network fee guarantee; see [cost pre-checking](api/cost-checker.md). |
| `tx_bad_auth` or an auth-entry signature verification failure after changing networks | The transaction/auth signature was prepared for a different network passphrase than the RPC network. | Set `networkPassphrase` to the passphrase for the same network served by `server` (for example, testnet is `Test SDF Network ; September 2015`). Keep guard address, RPC URL, and passphrase from the same deployment. |
| `watch()` yields no events, or `onStreamError` receives a terminal RPC error | The listener may be watching the wrong guard/network, starting after the events of interest, or may have exhausted its bounded retries. A process restart without persisted cursor state can also skip events. | Verify the listener's guard and RPC configuration, and subscribe before the actions to observe. Use `startLedger` for a ledger-range start or `cursor` with its `resumeLedger` for resume/gap detection; persist progress with `cursorStore` (and `failedTxCursorStore` separately when failed-transaction scanning is enabled). Handle `onGap` and `onStreamError`; the terminal error is also available from `getLastError()`. There is no `startFrom` option. See [telemetry listener](api/telemetry-listener.md). |
| `GuardTelemetryListener already has an active watch()/watchAll() stream` | A second stream was started on a listener that already owns an active stream. A listener shares cursor and de-duplication state and supports one active stream. | Finish/abort the existing stream before starting another, or create a separate `GuardTelemetryListener` for the independent stream. |

## What is not an SDK option

The current API does not expose `concurrency` or `startFrom`; do not add either
to an integration config expecting the SDK to act on it. Limit parallel work in
the caller, and use the supported timeout, cursor, and listener options above.
## Inspecting an `undetermined` check without a verdict

When `check()` returns `undetermined`, the guard made no ruling — but the raw
simulation is often what explains why. `simulateForDiagnostics()` runs the same
probe and enforced simulation under the same transport, signing and
`signal`/`timeoutMs` bounds, and returns diagnostics instead of a verdict:

```ts
const diagnostics = await interceptor.simulateForDiagnostics(call, {
  timeoutMs: 5_000,
  // includeRaw: true, // opt in to the undecoded event payloads
});

diagnostics.authoritative; // always false — never a policy verdict
if (!diagnostics.ok) console.error(diagnostics.error, diagnostics.detail);
console.log(diagnostics.resourceFeeStroops, diagnostics.resources);
console.log(diagnostics.guardEvent?.decision);
```

The result is explicitly non-authoritative (`authoritative: false`), performs no
broadcast and signs nothing for submission, and `includeRaw` defaults to `false`
so host payloads are redacted unless you ask for them.

## Authorization entries not signed

Ensure the invoke pipeline receives a valid agent key and that the custom account `__check_auth` policy admits the call. Blocked calls are rejected client-side before broadcast.

## No telemetry events emitted

Confirm the `GuardTelemetryListener` is subscribed before the invoke pipeline runs. Simulation diagnostics are only available during the pre-flight window.

## Agent Key Rotation and Recovery

See the [Agent Key Rotation and Recovery runbook](concepts/custom-account-signing.md#operator-runbook-agent-key-rotation-and-recovery) for procedures to rotate the agent key of a custom account and recover from rotation failures.

## Error classes

Use this section when a log gives you only a class name. For the compact class →
stage → meaning → retry → fail-closed → first-fix mapping, see the
[error catalog](errors.md#error-classes). There is exactly one entry per error
class exported from the package root, headed by the class name alone — message
text can change between releases, so it is listed inside the entry, never in
the heading. `tests/unit/troubleshooting-errors.test.ts` fails when an exported
error class has no entry here, or when an entry's **Retry** advice disagrees
with `isRetryableHeartbeatFailure()`.

Branch on the class with `instanceof` (or on a stable field such as `code`,
`rule`, `kind`, `path`), not on the message. The hierarchy and the 0.1.x
migration notes are in the README's
[typed errors section](../README.md#typed-errors-and-01x-migration); the
definitions are in [`src/errors.ts`](../src/errors.ts) and the modules named
below.

Every entry lists:

- **Extends** — the parent class, so you know which broader `instanceof` check catches it.
- **Typical messages** — the current shapes, with `<placeholders>`; illustrative, not a contract.
- **Stage** — where in the pipeline it is raised.
- **Retry** — `Yes` exactly when `isRetryableHeartbeatFailure()` classifies the
  class as a transient transport failure; `No` otherwise. `invoke()` already
  retries its own retryable classes (`stale_ledger_resource_limit`,
  `sequence_number_collision`, `min_fee`) inside its budget, so "Yes" means a
  *later* attempt may succeed, not that you should loop immediately.
- **First diagnostic** — the first command or check to run.

The examples use `RPC_URL` for your Soroban RPC endpoint:

```bash
export RPC_URL=https://soroban-testnet.stellar.org
```

### `GuardError`

- **Extends:** `Error`. Base class of every operational SDK error, so `instanceof GuardError` catches transport, signing, policy and simulation failures in one check. `InvalidInputError` (a `TypeError`), `InvokeRetryError` and `HeartbeatIntervalError` deliberately do not extend it.
- **Typical messages:** whatever the concrete subclass says; `GuardError` is not thrown directly.
- **Stage:** any.
- **Retry:** No — the base class alone says nothing about transience; classify the concrete subclass (`error.name`).
- **First diagnostic:** print the concrete class and its cause chain:

  ```ts
  console.error(error.name, error.message, (error as Error).cause);
  ```

### `GuardBlockedError`

- **Extends:** `GuardError`. Defined in [`src/reasons.ts`](../src/reasons.ts).
- **Typical messages:** `stellar-agent-guard blocked this action (<reason>): <explanation>`, optionally followed by ` [call: <contract>.<fn>(<n> args)]` and a detail line.
- **Stage:** `preflight` (thrown by `assertAllowed()` / adapters before execution; `charged: false`) or `submission` (the contract refused at broadcast; `charged` may be `true`).
- **Retry:** No — this is a policy decision. Change the policy, the call, or the account state (unpause, unfreeze, wait for the window to roll) instead.
- **First diagnostic:** read the reason and its operator guidance:

  ```ts
  console.error(error.reason, error.code, reasonMessagesEn[error.reason]);
  ```

  Then see the [blocked-reason row](#troubleshooting) above.

### `GuardUndeterminedError`

- **Extends:** `GuardError`.
- **Typical messages:** `stellar-agent-guard could not determine this action's status` followed by a detail line (`RPC call during 'pre-flight' exceeded timeout of <n>ms`, `call mapping failed before enforcement: …`, a simulation failure).
- **Stage:** `preflight` (from `assertAllowed()`, `assertBatchAllowed()` or the Vercel AI adapter) or `submission`.
- **Retry:** No — not by the SDK's predicate; the guard never ruled, so it fails closed. The real failure is the `cause`: if that is an `RpcTimeoutError`, `SimulationError` or `RateLimitedError`, a later attempt may succeed; an `AdapterMappingError` cause needs a code fix.
- **First diagnostic:** inspect the cause and the RPC:

  ```bash
  curl -s "$RPC_URL" -H 'content-type: application/json' \
    -d '{"jsonrpc":"2.0","id":1,"method":"getHealth"}'
  ```

### `PreFlightUndeterminedError`

- **Extends:** — it is the 0.1.x name of [`GuardUndeterminedError`](#guardundeterminederror), exported as an alias of the same class (`PreFlightUndeterminedError === GuardUndeterminedError`). An `instanceof` check against either name matches the same errors.
- **Typical messages:** as `GuardUndeterminedError`.
- **Stage:** as `GuardUndeterminedError`.
- **Retry:** No — as `GuardUndeterminedError`; inspect the `cause`.
- **First diagnostic:** as `GuardUndeterminedError`. Prefer the new name in new code; see the [0.1.x → 0.2 upgrade checklist](../MIGRATION.md#01x--02-upgrade-checklist).

### `InvalidInputError`

- **Extends:** `TypeError` (deliberately not `GuardError`), so a programmer error is distinguishable from an operational failure.
- **Typical messages:** `Invalid input for '<field>': violates rule '<rule>' (<detail>)` — for example `Invalid input for 'contract': violates rule 'required' (contract ID is required and must be non-empty)`.
- **Stage:** input validation, before any RPC.
- **Retry:** No — the same input fails the same way. Fix the value named by `field`.
- **First diagnostic:**

  ```ts
  console.error(error.field, error.rule, error.detail);
  ```

### `InvalidFeeCeilingError`

- **Extends:** `InvalidInputError` (so also a `TypeError`).
- **Typical messages:** `Invalid input for '<field>': violates rule 'non_negative_bigint' (expected a non-negative bigint, got <value>)`.
- **Stage:** `CostPreChecker` construction (configured `maxFeeStroops`) or a per-call override, before any simulation.
- **Retry:** No — pass a non-negative `bigint` in stroops (`500_000n`, not `500000` or `"500000"`). `0n` is a real zero ceiling; omit the option for no ceiling.
- **First diagnostic:**

  ```ts
  console.error(error.field, typeof error.value, error.value);
  ```

### `SimulationError`

- **Extends:** `GuardError`.
- **Typical messages:** `authorization probe failed`, `signed transaction simulation request failed`, `enforced simulation returned an invalid resource fee`, `could not assemble transaction from enforced simulation`.
- **Stage:** `probe`, `simulate` or `preflight` (the `stage` field).
- **Retry:** Yes — a simulation that could not run is a transport/host failure a later attempt can fix. If it repeats, check the RPC and the guard address before retrying further.
- **First diagnostic:** check RPC health, then the diagnostic events:

  ```bash
  curl -s "$RPC_URL" -H 'content-type: application/json' \
    -d '{"jsonrpc":"2.0","id":1,"method":"getHealth"}'
  ```

  ```ts
  console.error(error.stage, error.diagnosticEvents.length, error.cause);
  ```

### `RateLimitedError`

- **Extends:** `SimulationError`. `kind` is `"rate_limited"`, mirroring the verdict's `cause`.
- **Typical messages:** `the RPC rate-limited the simulation (HTTP 429) on <n> attempt(s)` with an optional `; Retry-After <ms>ms`.
- **Stage:** pre-flight simulation, after the interceptor's one bounded backoff and retry.
- **Retry:** Yes — after waiting at least `retryAfterMs` (when present). The lasting fix is operational: lower `maxConcurrentSimulations`, or raise the RPC's limit.
- **First diagnostic:**

  ```ts
  console.error(error.attempts, error.retryAfterMs);
  ```

### `RpcTimeoutError`

- **Extends:** `GuardError`. Defined in [`src/invoke.ts`](../src/invoke.ts); `kind` is `"timeout"`.
- **Typical messages:** `RPC call during '<stage>' exceeded timeout of <n>ms`, `RPC call during '<stage>' aborted by caller signal`, `RPC call during '<stage>' exceeded the overall invoke deadline`.
- **Stage:** the `stage` field (for example `pre-flight`); `deadline: true` means `deadlineMs` fired, `aborted: true` means your `signal` fired.
- **Retry:** Yes — but if `transactionHash` is set, the transaction was already broadcast and **may still land**: look it up before resubmitting, or you risk a duplicate transfer.
- **First diagnostic:** when a hash is present, ask the network what happened to it:

  ```bash
  curl -s "$RPC_URL" -H 'content-type: application/json' \
    -d '{"jsonrpc":"2.0","id":1,"method":"getTransaction","params":{"hash":"<transactionHash>"}}'
  ```

### `SigningError`

- **Extends:** `GuardError`.
- **Typical messages:** `signer.publicKey must not be a secret key (S...)…`, `signer.publicKey is not a supported agent identity: expected …`, `could not sign the guard authorization entry`, `could not validate the agent signer identity`.
- **Stage:** signer construction/validation, or auth-entry signing inside `invoke()` / `heartbeat()`.
- **Retry:** No — the signer or key is wrong or unavailable; retrying signs nothing new. Use the registered agent public key (`G…` or 64-char hex), never a secret seed.
- **First diagnostic:**

  ```ts
  console.error(error.address, isValidAgentPublicKey(signer.publicKey), error.cause);
  ```

### `BroadcastError`

- **Extends:** `GuardError`. `kind` is `"error"`.
- **Typical messages:** the RPC's rejection text, or `stellar-agent-guard broadcast failed: minimum fee not met after <n> attempt(s) (last fee: <n> stroops)` followed by a detail line.
- **Stage:** submission, after assembly.
- **Retry:** Yes — submission failures are transient more often than not. If `transactionHash` is set, check its status first; if `retry.exhausted` is `true`, the fee-bump budget is spent, so raise `feeBump` bounds deliberately rather than looping.
- **First diagnostic:**

  ```bash
  curl -s "$RPC_URL" -H 'content-type: application/json' \
    -d '{"jsonrpc":"2.0","id":1,"method":"getTransaction","params":{"hash":"<transactionHash>"}}'
  ```

### `FeeCapExceededError`

- **Extends:** `GuardError`. `code` is `"fee_cap_exceeded"`.
- **Typical messages:** `fee cap exceeded: total <n> stroops (resource <n> + inclusion <n>) exceeds maxFeeCap <n> stroops; nothing was broadcast`.
- **Stage:** `invoke()`, before `sendTransaction`. Nothing was broadcast.
- **Retry:** No — your own spend ceiling stopped it. Raise the ceiling (`invoke()`'s `maxFeeStroops`, or `CostPreChecker`'s `maxFeeStroops`) only if the budget allows, or wait for resource fees to fall.
- **First diagnostic:** see which half grew:

  ```ts
  console.error(error.resourceFeeStroops, error.inclusionFeeStroops, error.maxFeeCap, error.attempt);
  ```

### `InvokeRetryError`

- **Extends:** `Error` (not `GuardError`). Defined in [`src/invoke.ts`](../src/invoke.ts); returned as the `kind: "error"` outcome, not thrown.
- **Typical messages:** `stellar-agent-guard invoke retry budget exhausted after <n> attempt(s) (last cause: <cause>)` followed by the last attempt's detail.
- **Stage:** `invoke()`, after the bounded retry budget for `stale_ledger_resource_limit` / `sequence_number_collision` / `min_fee` ran out.
- **Retry:** No — the SDK's own budget is already spent. Fix the cause (`sequence_number_collision` usually means another broadcaster shares the source account) and check `transactionHash`: the last attempt may be on the network.
- **First diagnostic:**

  ```ts
  console.error(error.lastCause, error.retry, error.transactionHash, error.error);
  ```

### `ContractResponseError`

- **Extends:** `GuardError`.
- **Typical messages:** `simulation result is not an object`, `simulation result.auth is not an array`, `validate_policy simulation returned no result.retval`, or a malformed `minResourceFee`.
- **Stage:** the optional `stage` field — `probe`, `simulate`, `preflight` or `assemble`.
- **Retry:** No — the response shape is wrong, which usually means an incompatible RPC, a wrong network, or a guard WASM this SDK version does not understand.
- **First diagnostic:** confirm the RPC network matches your `networkPassphrase`:

  ```bash
  curl -s "$RPC_URL" -H 'content-type: application/json' \
    -d '{"jsonrpc":"2.0","id":1,"method":"getNetwork"}'
  ```

  Then log `error.field` and `error.stage`.

### `PolicyDecodeError`

- **Extends:** `GuardError`.
- **Typical messages:** `cannot decode policy JSON field <path>: <detail>` ([`policyFromJson()`](api/policy-json.md#error-paths)), `cannot decode policy field <path>: <detail>` (`decodePolicy()` / `policyFromScVal()`), `validate_policy returned an undecodable ScVal`.
- **Stage:** decoding a policy from JSON, from a contract `ScVal`, or from a `validate_policy` simulation.
- **Retry:** No — the bytes are not a policy this SDK understands; the same input fails the same way.
- **First diagnostic:**

  ```ts
  console.error(error.path, error.message);
  ```

  For JSON input, compare the field at `path` with the [format table](api/policy-json.md#the-format).

### `PolicyEncodeError`

- **Extends:** `InvalidInputError` (so also a `TypeError`).
- **Typical messages:** `Invalid input for '<path>': violates rule '<rule>' (<detail>)`, with ` (and <n> more failure(s))` when there are several.
- **Stage:** `policyToScVal()`, before any `ScVal` is built.
- **Retry:** No — fix every entry in `failures`.
- **First diagnostic:** list every failure, not just the first:

  ```ts
  console.table(error.failures);
  // or, without throwing: validatePolicyForEncoding(draft)
  ```

### `PolicyFileReadError`

- **Extends:** `GuardError`. Raised by `loadPolicyFromFile()` from `stellar-agent-guard-sdk/fs`.
- **Typical messages:** `cannot read policy file '<path>' (<errno>)`.
- **Stage:** filesystem read, before any parsing.
- **Retry:** No — fix the path or permissions named by `code` (`ENOENT`, `EACCES`, `EISDIR`, …).
- **First diagnostic:**

  ```bash
  ls -l "<path>"
  ```

### `PolicyValidationError`

- **Extends:** `GuardError`. Raised by `loadPolicyFromFile()` after a successful decode.
- **Typical messages:** `policy file '<path>' failed validation with <n> failure(s): <rule> at <field>; …`.
- **Stage:** SPEC §8 validation of a decoded policy file.
- **Retry:** No — edit the policy; every failure is in `failures`.
- **First diagnostic:**

  ```ts
  console.table(error.failures);
  ```

  The rule ids are explained in [policy schema validation](api/policy-schema.md#schema-enforced-vs-code-enforced-rules).

### `AdapterMappingError`

- **Extends:** `GuardError`. Usually seen as the `cause` of an `undetermined` adapter halt.
- **Typical messages:** `the <adapter> adapter's call mapper threw: <original message>`, or a mapper that returned something that is not a contract call.
- **Stage:** adapter call mapping, before enforcement. The wrapped tool did not run.
- **Retry:** No — the mapper is application code; fix the function named by `field` (`toContractCall` or `toContractCalls`).
- **First diagnostic:**

  ```ts
  console.error(error.field, error.cause);
  ```

  See [call mapping and mapping failures](api/framework-adapters.md#call-mapping-and-mapping-failures).

### `AdapterConfigError`

- **Extends:** `GuardError`.
- **Typical messages:** `<adapter> adapter options are invalid: <n> problem(s) found (<fields>).` followed by one line per problem.
- **Stage:** adapter construction, before the first agent action.
- **Retry:** No — a configuration bug; fix the option named by `field` to match `expected`.
- **First diagnostic:**

  ```ts
  console.error(error.adapter, error.field, error.expected);
  ```

### `HeartbeatBlockedError`

- **Extends:** `GuardError`. Defined in [`src/heartbeat.ts`](../src/heartbeat.ts).
- **Typical messages:** `stellar-agent-guard blocked the heartbeat (<reason>): <explanation>` — typically `heartbeat_expired` or `admin_frozen`.
- **Stage:** heartbeat submission (`heartbeat()` or `startHeartbeat()` via `onError`).
- **Retry:** No — a refused heartbeat is a decision. An expired or frozen account needs an admin [unfreeze](https://github.com/Stellar-Agent-Guard/stellar-agent-guard-contracts/blob/main/docs/functions/freeze-unfreeze.md) (`submitUnfreeze()`).
- **First diagnostic:** read the account status:

  ```ts
  const status = await readGuardStatus({ server, guard, source, networkPassphrase });
  console.error(error.reason, status, dmsUrgency(status, policy));
  ```

### `HeartbeatDryRunError`

- **Extends:** `GuardError`. `kind` is `"dry_run"`.
- **Typical messages:** `stellar-agent-guard heartbeat ran as a dry run and never reached the guard (verdict: <verdict>…)`.
- **Stage:** heartbeat submission whose outcome was `kind: "dry_run"` — typically a custom `submit` transport that calls `invoke({ dryRun: true })`. The dead-man switch was not touched.
- **Retry:** No — re-sending the same dry-run configuration cannot help. Remove `dryRun: true` from the heartbeat's `submit` transport.
- **First diagnostic:**

  ```ts
  console.error(error.verdict, error.reason, error.detail);
  ```

### `HeartbeatIntervalError`

- **Extends:** `Error` (not `GuardError`).
- **Typical messages:** `heartbeat interval <n>ms exceeds one third of the dead-man grace window (<n>s → at most <n>ms); a single missed beat could freeze the account`.
- **Stage:** `startHeartbeat()`, before the first beat.
- **Retry:** No — set `intervalMs` to at most `maxIntervalMs`.
- **First diagnostic:**

  ```ts
  console.error(error.intervalMs, error.graceSecs, error.maxIntervalMs);
  ```

### `ConcurrentTelemetryStreamError`

- **Extends:** `GuardError`. Defined in [`src/telemetry.ts`](../src/telemetry.ts); `code` is `"telemetry.concurrent_stream"`.
- **Typical messages:** `GuardTelemetryListener already has an active watch()/watchAll() stream; <requested>() cannot start concurrently. Use one listener per stream.`
- **Stage:** `watch()` / `watchAll()` start-up, before any RPC.
- **Retry:** No — not while the first stream is active. End or abort it, or create a second `GuardTelemetryListener`.
- **First diagnostic:**

  ```ts
  console.error(error.requested, listener.health());
  ```
