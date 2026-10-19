# SDK design principles

These are the commitments that decide what the SDK is allowed to become. They are
not style preferences: each one exists because the package sits between an
autonomous agent and real funds, and a convenient shortcut at this layer becomes a
security regression at the account layer. The principles are the SDK half of the
project's security posture — the contracts half is the on-chain policy engine
described in the contracts repo's
[`SPEC.md`](https://github.com/Stellar-Agent-Guard/stellar-agent-guard-contracts/blob/main/SPEC.md).

Read this before proposing a change to the public surface, the dependency set, or
the runtime environment the SDK runs in. When a change genuinely has to depart from
a principle, the departure is a **maintainer decision** (label
`tier:maintainer-decision`, per the [label taxonomy](../CONTRIBUTING.md#issues-and-labels)),
recorded in the pull request — never a silent exception.

| # | Principle | In one line | Exception path |
|---|---|---|---|
| 1 | [Fail closed](#1-fail-closed-an-undetermined-verdict-halts) | An `undetermined` verdict is treated as not-allowed and kept distinct from a refusal. | Maintainer decision |
| 2 | [No secret handling, ever](#2-no-secret-handling-ever) | The SDK never accepts, derives, or stores a private key; the account stays non-custodial. | Maintainer decision |
| 3 | [One runtime dependency](#3-one-runtime-dependency) | `@stellar/stellar-sdk` is the only `dependencies` entry, deliberately. | Maintainer decision |
| 4 | [Additive-only 0.x surface](#4-additive-only-0x-surface) | Existing symbols keep their meaning; new capability is appended, not substituted. | Maintainer decision + breaking-change note |
| 5 | [No backend, browser-safe core](#5-no-backend-browser-safe-core) | The SDK is a library, not a service; Node-only I/O never enters the root entry. | Maintainer decision + subpath export |
| 6 | [Logger-optional silence](#6-logger-optional-silence) | The SDK emits nothing on its own and depends on no logger. | Maintainer decision |

---

## 1. Fail closed: an undetermined verdict halts

### Rationale

The guard is a security control, and the first duty of a security control is to
fail in the safe direction. A pre-flight `check()` returns three outcomes and keeps
them distinct on purpose: `admissible`, `blocked`, and `undetermined`, where
`undetermined` means the enforcement run failed for a reason that is **not** a
policy decision — a contract trap, a missing trustline, an unsupported credential
type (`src/preflight.ts:18`). The SDK treats `undetermined` as not-allowed: a
guardrail must fail closed. It stops short of relabelling it `blocked`, because an
adapter must never claim the guard refused something it never ruled on. This is the
SDK side of the contracts threat model's "what this does and does not do" — a
compromised or confused agent cannot turn an unreadable answer into permission
([SPEC §10](https://github.com/Stellar-Agent-Guard/stellar-agent-guard-contracts/blob/main/SPEC.md#10-threat-model-what-this-does-and-does-not-do)).

The same reasoning governs the result-oriented pipeline: `invoke()` reports a stage
failure as `kind: "error"` carrying the typed error, and `PreFlightUndeterminedError`
extends `SimulationError`, so a caller that wants throw-on-refusal still cannot
reach broadcast on an unknown. The optional simulation cache stores only actual
`admissible` and `blocked` decisions — a transient `undetermined` is never cached,
because caching it would turn a momentary failure into a persistent allow.

### Rejected pattern

Catching a simulation error and returning `admissible` "so the agent keeps working"
(optimistic default-allow), or flattening `undetermined` into `blocked` so callers
cannot tell a refusal from an unreadable RPC. Also rejected: caching an
`undetermined` result, and letting an adapter treat "the check threw" as "proceed".

### Exception path

No default-allow path is ever added without a maintainer decision recorded on the
pull request with the `tier:maintainer-decision` label, stating the threat this
reopens and why the alternative is worse.

---

## 2. No secret handling, ever

### Rationale

The project's core security claim is that the account is **non-custodial**: funds
live in the agent's own smart account, and the policy engine holds no fund-moving
authority of any kind
([SPEC §1](https://github.com/Stellar-Agent-Guard/stellar-agent-guard-contracts/blob/main/SPEC.md#1-mechanism-and-non-custodial-guarantee)).
The SDK is the integration layer in front of that, and it inherits the posture: it
must never become a place a key could leak from. Signing accepts a caller-created
signer and nothing else — `AgentSigner | Keypair` — so key material stays in the
caller's process. The one verification helper, `verifyAgentSignature`, is
verify-only by design: it never accepts, signs with, stores, or derives a private
key; it proves a public-key/payload/signature relationship and no more. The
signature binding that makes this safe (agent signature ≠ admin authority) is
spelled out in
[SPEC §10.1](https://github.com/Stellar-Agent-Guard/stellar-agent-guard-contracts/blob/main/SPEC.md#101-signature-binding).

A testnet key read from a gitignored `.env.phase2` is a **test harness** concern,
not an SDK API: `tests/integration/harness.ts` validates and consumes it, and the
SDK's own modules never read it.

### Rejected pattern

Adding an SDK helper that reads a secret from `process.env`, generates a keypair
"for convenience", persists a key, or wraps a remote custodial signer that holds
secret material server-side. Also rejected: any helper that accepts a seed so it
can sign on the caller's behalf.

### Exception path

Any API that would touch secret material requires a maintainer decision
(`tier:maintainer-decision`) and a written answer to "where does the key live, and
who can read it" — the default answer is "outside this package".

---

## 3. One runtime dependency

### Rationale

`package.json` declares exactly one runtime dependency: `@stellar/stellar-sdk`,
because encoding ScVal, building transactions, and talking Soroban RPC is
irreducibly the platform's job and reimplementing it would be worse, not safer. The
dependency set is a supply-chain surface, and for a package that other people's
funds flow through, every added transitive tree is additional code that can break
or be compromised. The framework adapters are written *structurally* against each
host's hook (`src/index.ts:267`), so LangChain and ElizaOS are **not** dependencies
— a genuine pre-execution blocking hook is all the adapter needs.

The honest cost is documented rather than hidden: pinning `@stellar/stellar-sdk` ^17
means the SDK cannot cancel an in-flight `getEvents` request, because that version
exposes no per-request `AbortSignal`. That limitation is published in the README
rather than paid for with a second dependency.

### Rejected pattern

Adding a logger, a polyfill, a date library, a crypto wrapper, or a framework SDK to
`dependencies` to make one call site tidier. Also rejected: promoting a
`devDependency` (or a benchmark/CI-only package such as `tinybench`) into the
runtime set.

### Exception path

A new runtime dependency requires a maintainer decision (`tier:maintainer-decision`)
that names what the dependency replaces, its tree size, and why calling
`@stellar/stellar-sdk` directly cannot cover it. `devDependencies` are unaffected —
they never ship to consumers.

---

## 4. Additive-only 0.x surface

### Rationale

The package is 0.x and is already published, so consumers exist and they pin. A
minor release must not move a contract out from under them. The SDK's own stability
vocabulary is defined in [`docs/event-schema.md`](event-schema.md): **Stable**
(nothing changes without a documented breaking change and a migration note),
**Append-only** (new values may appear; existing ones are never re-spelled,
re-meant, or reused), **Best-effort** (host/RPC-supplied), and **Internal** (not
part of the surface). Event decoding is the clearest instance and the model to copy
elsewhere: an unknown name topic is **dropped, not guessed** (`interpret()` returns
`null`), and `GUARD_REASON_CODES` are never renumbered or reused. Consumer-facing
types such as `InvokeOutcome` and `PreFlightDecision` are discriminated unions so a
new variant is an additive change a switch can handle.

The one intentional behavior change in 0.1.x — `dryRun: true` returning
`kind: "dry_run"` instead of the old `kind: "error"` sentinel — is shipped with a
migration note precisely because additive-only does not mean "pretend nothing ever
changes"; it means a change is named, documented, and scoped.

### Rejected pattern

Renaming a Stable export, re-using an existing reason symbol for a new condition,
changing a field's type or meaning, or silently altering `dryRun` semantics without
a migration note. Also rejected: "it was probably not used" as a justification for
a breaking rename in a 0.x minor.

### Exception path

A breaking change requires a maintainer decision (`tier:maintainer-decision`) **and**
a documented breaking change plus a migration note, following the pattern already
set in [`MIGRATION.md`](../MIGRATION.md). Until then, extend the surface; do not edit
it.

---

## 5. No backend, browser-safe core

### Rationale

The SDK is a client library, not a service. It holds no server, no queue, no
long-running daemon, and no filesystem requirement in its root entry. Enforcement
lives on-chain in `__check_auth`, which is the single enforcement vector
([SPEC §1](https://github.com/Stellar-Agent-Guard/stellar-agent-guard-contracts/blob/main/SPEC.md#1-mechanism-and-non-custodial-guarantee));
the SDK is the pre-flight/telemetry layer in front of it and must not grow a
privileged middle tier between the agent and the chain. The dashboard runs in an
operator's browser and embedded/edge agent runtimes are a stated target
([`docs/benchmarks.md`](benchmarks.md)), so the public core has to be importable in
a browser bundle.

The rule that follows is where the "load `fs` via a subpath" guidance comes from:
**Node-only capabilities never enter the core.** If a future feature needs the
filesystem (reading a WASM artifact, say) or a raw socket, it is exposed through an
explicit `exports` subpath — so `import "stellar-agent-guard-sdk"` stays
browser-safe and a consumer opts into the Node-only surface by path. Today the only
`node:fs` usage is in a **caller** example in `verifyGuardWasm`'s documentation,
not in shipped code, and `verifyGuardWasm` itself hashes through WebCrypto
(`globalThis.crypto.subtle`) so the same call runs in Node and the browser.

**Current state, verified rather than claimed.** The root entry carries no
filesystem, HTTP, or server code and imports no Node built-ins. SHA-256 for
pre-flight cache fingerprints, auth-entry signing and telemetry ids goes through
the Stellar SDK's browser-compatible hashing (`src/hash.ts`), so it is synchronous
and needs no `node:crypto` or async WebCrypto boundary. `npm run test:browser`
bundles the built root entry with esbuild for `platform: "browser"` and fails if
any `node:*` input is reachable; a unit test runs the same check against
`src/index.ts`. Never add another Node-only import to a core module without the
exception path below.

### Rejected pattern

Importing `node:fs`, `node:http`, `node:net`, or a server framework into a core
module; adding a top-level "read the wasm file" convenience helper; standing up a
proxy/gateway process that the SDK depends on; or declaring the package
"browser-safe" while relying on bundler polyfills to paper over Node built-ins.

### Exception path

Any Node-only capability requires a maintainer decision (`tier:maintainer-decision`)
and must ship behind an explicit subpath export (the `fs`-via-subpath pattern), so
importing the root never pulls it. The export map is exercised end to end by
`npm run test:exports`, which also proves undeclared paths are refused.

---

## 6. Logger-optional silence

### Rationale

A library in the enforcement path must not decide what gets printed, where, or to
whom. The SDK itself **never logs** and takes **no logger dependency**: observability
is a callback the consumer owns. `invoke()` exposes an optional `onStep`, and the
telemetry listener an optional `onGap`; omitted, behavior is exactly as before.
Callback exceptions are isolated — a throwing hook never breaks the pipeline and
never masks the real error — because observability must never decide whether a
transaction runs (`src/invoke.ts:296`). The same silence serves principle 2: a
library that logs is a library that can log something it should not, and there is no
sink here through which a secret, payload, or address could escape.

### Rejected pattern

Calling `console.log`/`console.error`/`process.stderr.write` from library code;
adding a required logger config; emitting telemetry to a hard-coded endpoint; or
introducing a log level the consumer must set for the SDK to be quiet. Also
rejected: letting a throwing `onStep`/`onGap` propagate into the pipeline.

### Exception path

Any built-in output requires a maintainer decision (`tier:maintainer-decision`) and
must remain opt-in and silent by default. "It helps debugging" is not sufficient: the
debugging seam already exists as the dry-run trace and the `onStep` hook.

---

## Cross-links

### Threat model

The project's threat model is currently the canonical
[`SPEC.md` §10](https://github.com/Stellar-Agent-Guard/stellar-agent-guard-contracts/blob/main/SPEC.md#10-threat-model-what-this-does-and-does-not-do)
in the contracts repo — read it as the source of truth for what the guard does and
does not defend against. The SDK-side `docs/threat-model.md` is **pending**; this
document and that one are meant to be mutual links once it exists.

<!-- TODO(#162): when docs/threat-model.md lands, add a reciprocal link from it to
     this section, and replace this pending note with a direct link. Until then the
     contracts SPEC §10 is the linked threat model. -->

### Stability tiers

The four-tier stability vocabulary this document leans on (Stable, Append-only,
Best-effort, Internal) is defined in [`docs/event-schema.md`](event-schema.md),
together with the field-by-field table. Principle 4 is the SDK-wide reading of that
document's compatibility contract.

### Dependency posture

There is no dedicated dependency-posture section in the README, so the source of
truth for principle 3 is [`package.json`](../package.json) (`dependencies` holds
`@stellar/stellar-sdk` alone; the framework and tooling packages are
`devDependencies`). The README documents the practical consequences where a consumer
meets them: the SDK "takes no logger dependency"
([`onStep`](../README.md#pipeline-step-observability-onstep)) and the
`@stellar/stellar-sdk` ^17 pin behind the
[watch-cancellation limitation](../README.md#aborting-a-watch-what-cancellation-does-and-does-not-cover).
The security posture this all serves is stated in the README's
[disclaimer](../README.md) and the contracts repo's
[SECURITY.md](https://github.com/Stellar-Agent-Guard/stellar-agent-guard-contracts/blob/main/SECURITY.md).
