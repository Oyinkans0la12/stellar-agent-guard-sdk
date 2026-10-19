# Changelog

All notable changes to `stellar-agent-guard-sdk` are documented in this file.

The format follows [Keep a Changelog 1.1.0](https://keepachangelog.com/en/1.1.0/).
Versioning follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html) with
the 0.x interpretation documented in [`docs/releasing.md`](docs/releasing.md): during
0.x the **minor** version is the compatibility boundary, and within any `0.1.x` series
the SDK is additive-only.

User-facing changes need an **Unreleased** row here, added in the same pull request
as the change — see [`CONTRIBUTING.md`](CONTRIBUTING.md).

## [Unreleased]

### Added

- `signal` and `timeoutMs` on `check()`, `invoke()` and `CostPreChecker.check()`, plus `RpcTimeoutError` and `DEFAULT_RPC_TIMEOUT_MS`: a hung Soroban RPC can no longer leave a guardrail call pending forever. `check()`/`cost()` report a fired bound as a fail-closed `undetermined` verdict carrying the typed `RpcTimeoutError`; `invoke()` surfaces the same error through its `error` outcome (#114).
- `dmsUrgency()` and `DMS_WARN_RATIO_DEFAULT`: client-side `'ok' | 'warn' | 'expired' | 'unknown'` dead-man countdown urgency, with the same edge semantics as `deadManRemaining` (#132).
- `policyDiff()` and the `PolicyChange` type: set-aware structured diff between two policies for operator display (#131).
- Bounded retry and backoff for a failed heartbeat submission: `retry: { maxAttempts, baseDelayMs, maxDelayMs, random }` on `startHeartbeat()`, plus `DEFAULT_HEARTBEAT_RETRY_OPTIONS`, the `HeartbeatRetryOptions` type, the typed `HeartbeatBlockedError`, and `isRetryableHeartbeatFailure()`. Only a transport failure is retried — a policy block is never retried — and the attempt that failed plus the delay before the next one are announced through `onWarning` while the final failure is reported once through `onError` (#340).
- `describePolicy(policy, options?)` now reports the advanced constraints — the blocked recipients, the per-recipient window caps, and the active window with its state — with a `DescribePolicyOptions` type (`detail`, `nowSecs`) and an `ActiveWindowState` type. Recipient lists are reported as counts unless `detail: true` asks for the addresses, and the output is stable across policies that store the same lists in a different order (#343).
- `onBeat` receives the number of attempts a beat took in its new `attempt` field (#340).
- `validateGuardEventXdr()`: strict offline validation for captured event XDR, reporting every failure with its input index, stable path, pipeline stage, and code, while leaving the resilient live decoders unchanged (#290).
- Unknown committed-event topics are now observable without a logger: `poll()` returns `unknownTopics` (`{ topic, count }[]`) and `watch()`/`watchAll()` accept `onUnknownTopics`, exposing decoded names and per-page counts only — never raw XDR or source payloads. Unknown topics still stay out of `GuardEvent` and the listener buffer (#287).

### Changed

- Committed telemetry pages now share one ordering rule across `poll()`, `watch()`, and `watchAll()`: ledger ascending, then transaction hash, topic, and stable id as tie-breakers for same-ledger events. Diagnostic observation order is unchanged (#289).
- `GuardTelemetryListener` now rejects a concurrent `watch()`/`watchAll()` stream with `ConcurrentTelemetryStreamError` instead of letting two iterators race shared cursor, counter, and buffer state (#291).
- RPC calls are now bounded by default: `timeoutMs` defaults to `DEFAULT_RPC_TIMEOUT_MS` (30s) instead of waiting indefinitely. Pass `timeoutMs: 0` to restore the previous unbounded behaviour, or `signal` to cancel from your own runtime (#114).
- `recent()` on the telemetry listener and on `GuardEventRingBuffer` returns **detached snapshots**: the array, the events, their decoded `data`/`decision` and the opt-in `raw` payload are copies, so a consumer can no longer change the retained state by editing what it was handed (#344).
- A heartbeat that the guard **refuses** is now reported as a failed beat (a typed `HeartbeatBlockedError` through `onError`) instead of being counted as an accepted beat (#340).

### Deprecated

None.

### Removed

None.

### Fixed

- `startHeartbeat()` now validates its inputs before the scheduler exists: a negative or non-finite `maxSkewMs`, a grace window that is not a non-negative safe integer or bigint, a callback that is not callable, and an unusable retry budget are all rejected with an error naming the field — before the first beat, and before the grace window is read from the chain (#341).

### Security

None.

## [0.1.0] - 2026-09-16

> **Pre-0.1.1 history is reconstructed.** This file did not exist when `0.1.0`
> shipped, so the entry below is the *publish record* — assembled from
> [`docs/publishing-history.md`](docs/publishing-history.md) and
> `npm view stellar-agent-guard-sdk` — not a per-change log. Per-change history
> starts with entries added under [Unreleased].

### Added

- Initial publication of `stellar-agent-guard-sdk` to the npm registry: pre-flight
  policy interception and guardrails for AI agents on Stellar Soroban smart accounts
  (registry package description).

### Changed

None.

### Deprecated

None.

### Removed

None.

### Fixed

None.

### Security

None.

> **Two facts about `0.1.0`, recorded rather than smoothed over:**
>
> 1. It was published **manually by the maintainer, outside the tag-triggered
>    `publish.yml` workflow** — no release tag or `publish` workflow run exists for
>    `0.1.0`. Known one-time deviation; see
>    [`docs/publishing-history.md`](docs/publishing-history.md).
> 2. `package.json` declares `0.1.1`, but when this entry was written the registry
>    reported `0.1.0` as the only published version (`latest` dist-tag), verified with
>    `npm view stellar-agent-guard-sdk versions time`. This changelog records what is
>    **actually on the registry**: `0.1.0`, on the date above. No `0.1.1` entry is
>    written until `0.1.1` is published.

[unreleased]: https://github.com/stellar-agent-guard/stellar-agent-guard-sdk/commits/main
[0.1.0]: https://www.npmjs.com/package/stellar-agent-guard-sdk/v/0.1.0
