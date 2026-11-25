<!-- npm keywords: stellar, soroban, ai-agents, guardrails, stellar-sdk, policy, firewall, langchain, elizaos, non-custodial, smart-account, custom-account-abstraction, spend-limits, allowlist, telemetry, typescript, web3, blockchain-security -->
<p align="center">
<img src="Gemini_Generated_Image_mvimg2mvimg2mvim.jpeg" alt="Stellar Agent Guard" width="700"/>
</p>
<p align="center">
<a href="https://github.com/aigbagbobila/stellar-agent-guard-sdk/actions/workflows/ci.yml">
<img src="https://github.com/aigbagbobila/stellar-agent-guard-sdk/actions/workflows/ci.yml/badge.svg" alt="CI"/>
</a>
<a href="LICENSE">
<img src="https://img.shields.io/badge/license-MIT-blue" alt="License: MIT"/>
</a>
<a href="https://nodejs.org/">
<img src="https://img.shields.io/badge/node-24%2B-blue" alt="Node 24+"/>
</a>
<!-- docs: <a href="#"><img src="https://img.shields.io/badge/docs-GitBook-blue" alt="Documentation"/></a> (added in P2 once GitBook URL is confirmed live) -->
</p>

# Stellar Agent Guard — SDK

**New here?** The [glossary of guard terms](docs/glossary.md) is the quickest way to learn the shared vocabulary (admissible, blocked, undetermined, DMS, SAC, auth entry) with links to the authoritative contract and SDK sections.

<!-- 📚 **[Documentation](...)** (added in P2 once GitBook URL is confirmed live) -->

**Non-custodial TypeScript SDK and pre-flight policy interception firewall for AI agents on Stellar.**

An autonomous agent holding a wallet has a single point of failure: one prompt-injection or one buggy loop can drain it. Stellar Agent Guard makes that impossible on-chain — the agent's funds stay in its own smart account, and *every* transaction the account must authorize is intercepted by the contract's  and rejected pre-broadcast unless it satisfies the operator's installed policy: per-transaction spend caps, a rolling-window spend limit, recipient/asset allowlists, protocol allowlists, a pause switch, and a dead-man switch. This SDK provides the integration layer: pre-flight simulation interception, zero-broadcast fee estimation, agent-auth transaction signing, and dual-stream event telemetry for AI agent frameworks (LangChain, ElizaOS).

**Status: Phase 2 complete — and the package is published.** [`stellar-agent-guard-sdk@0.1.1`](https://www.npmjs.com/package/stellar-agent-guard-sdk) is live on the npm registry (`npm install stellar-agent-guard-sdk`). All five enforcement scenarios were proven against live Stellar testnet (protocol 28) with real contract IDs, transaction hashes, and diagnostic events — evidence is recorded in [`tests/fixtures/integration-evidence.md`](tests/fixtures/integration-evidence.md). Phase 2 code is merged into `main` with green CI (`ci` status check). For historical release notes and publish pipeline reconciliation, see [`docs/publishing-history.md`](docs/publishing-history.md).

## 🎯 What makes this different

Enforcement happens **inside the account itself**, via Soroban's native Custom Account Abstraction — not in a wrapper contract in front of funds, and not in an off-chain service.

- **Pre-flight simulation without broadcast**: The SDK evaluates guard approval against Soroban RPC before a single byte hits the network. If the transaction violates policy, it is rejected client-side with the contract's own reason code, incurring zero network fees.
- **Dual-stream telemetry**: Blocked decisions never commit to the ledger because Soroban rolls back failed authorizations. A listener that only tails committed ledger events sees a guard that appears to approve everything. The SDK extracts `event_auth_checked` from simulation diagnostics as well as committed blocks.
- **In-process simulation pricing**: `CostPreChecker` computes network resource and inclusion fees directly from the enforced simulation, avoiding dependencies on external profiling tools.
- **Framework middleware**: Plug-and-play middleware for LangChain and validators for ElizaOS halt execution before external tool calls run.

> ⚠️ **Disclaimer:** This is unaudited security tooling that gates real fund access. Do not deploy to mainnet without an independent audit. See the contracts repo's [SECURITY.md](https://github.com/aigbagbobila/stellar-agent-guard-contracts/blob/main/SECURITY.md).

## What it does

- **Pre-flight policy interception (`PreFlightInterceptor`)**: Intercepts contract calls before broadcast, simulates auth authorization, and returns a discriminated `admissible`, `blocked`, or `undetermined` verdict. Never throws on policy refusal; an opt-in short-lived cache can reduce repeated simulation RPC calls within the current ledger.
- **In-process cost pre-checking (`CostPreChecker`)**: Prices transaction execution from simulation results, reporting resource fees, inclusion fees, and total fees against an optional ceiling.
- **Autonomous transaction execution (`invoke()`)**: Executes the full Soroban lifecycle: probe simulation, auth signing for custom accounts, enforced simulation, and broadcast with bounded retry for stale ledger resource limits (`scecExceededLimit`) and minimum-fee rejections (`tx_insufficient_fee`).
- **Framework adapters**:
  - `createLangChainGuardMiddleware`: Halts tool execution if the interceptor blocks the planned action.
  - `createGuardValidator`: ElizaOS action validator returning boolean verdicts before actions run.
  - `createVercelAIGuard`: Vercel AI SDK tool wrapper asking the guard before a tool's `execute` runs.
- **Running an agent 24/7**: the complete runtime loop — heartbeat, pre-flight every transfer, telemetry alerts and DMS countdown monitoring, with a fail-closed failure-mode table — is in [`docs/agent-runtime.md`](docs/agent-runtime.md).
- **Telemetry listener (`GuardTelemetryListener`)**: Tails both committed events and diagnostic streams, decoding contract topics and reason codes. Opt-in sliding-window counters expose agent self-monitoring via `stats()`.

> ⚠️ **Trust & limitations:** pre-flight is an **advisory**, zero-broadcast
> guardrail — it reports what the simulation predicts the guard will do, and it
> can be wrong if the RPC lies. It does **not** replace the contract: every
> authorized call is enforced on broadcast by `__check_auth`, and a malicious
> RPC can feed a fake pre-flight verdict but cannot forge the agent's signature
> or the guard's own decision event. See
> [`docs/threat-model.md`](docs/threat-model.md) for the full threat model
> (verdict-inversion, stale-cache verdicts, compromised runtime, fake-RPC
> simulation, single-dependency supply chain).

## Quick Start

> **A verdict is a prediction, not a settlement guarantee.** Before relying on a
> pre-flight approval, read [Fidelity & limits](#fidelity--limits) — the four
> known gaps in simulation fidelity, and what the SDK does about each.
>
> **If something breaks:** search the [error catalog](docs/errors.md#error-classes)
> by class name, or the [troubleshooting playbook](docs/troubleshooting.md) by
> error text or outcome.

New to the vocabulary (allowlist, DMS, admissible, pre-flight)? Start with the
[glossary](docs/glossary.md).

### 60-second quickstart: see the guard say no

One contiguous path: install, point at the Phase-2 testnet fixture, simulate a
transfer that violates its per-transaction cap, and print the verdict. Pre-flight
is read-only — it broadcasts nothing and pays no network fee.

```bash
npm install stellar-agent-guard-sdk
set -a; . ./.env.phase2; set +a   # agent + funded source secrets
npx tsx quickstart.ts
```

```ts
/**
 * 60-second quickstart (issue #127): see the guard say no.
 *
 * Mirrored verbatim in README.md (except the package import specifier, which the
 * unit test rewrites to this file's relative import). `npm run typecheck`
 * typechecks this file, so the README block cannot drift from code that
 * compiles.
 *
 * Pre-flight is read-only: this runs the guard's `__check_auth` in simulation,
 * prints the verdict and never broadcasts. The enforced simulation does sign the
 * agent auth entry and reads a funded source account, so two testnet secrets are
 * required — the verdict itself costs no fee and no funds move.
 */
import { Keypair, nativeToScVal, rpc } from "@stellar/stellar-sdk";
import { PreFlightInterceptor, isContractAddress } from "stellar-agent-guard-sdk";

const RPC_URL = "https://soroban-testnet.stellar.org";
const NETWORK_PASSPHRASE = "Test SDF Network ; September 2015";

// Phase-2 testnet fixture (tests/fixtures/phase2-instance.json). Override these
// three with your own instance's addresses if you deployed one.
const GUARD =
  process.env.STELLAR_GUARD ?? "CAPADGEK457RHKN4RYVUMDJTFHDSG7R5HREQONKLYK7MFKC5WFENPP44";
const TOKEN =
  process.env.STELLAR_TOKEN ?? "CDCYDGBGS5AZ5BZS6XY2SK2PHJHSOEGTN3N4INCK34KF6GU2BGC7Z6MB";
const RECIPIENT =
  process.env.STELLAR_RECIPIENT ?? "GAOBCRXTCO4ZCBNHALJUMJJ5JDXNOUZ7U6VZJX4UBTXAHQEO66IPU6PH";

async function runQuickstart(): Promise<void> {
  // The fixture's agent secret and a funded testnet source account. The
  // fixture's secrets are deliberately not committed; see README "Live testnet
  // suite" for provisioning your own instance.
  const agentSecret = process.env.PHASE2_AGENT_SECRET;
  const sourceSecret = process.env.PHASE2_ADMIN_SECRET;
  if (!agentSecret || !sourceSecret) {
    throw new Error("set PHASE2_AGENT_SECRET and PHASE2_ADMIN_SECRET (see .env.phase2.example)");
  }
  if (!isContractAddress(GUARD) || !isContractAddress(TOKEN)) {
    throw new Error("STELLAR_GUARD and STELLAR_TOKEN must be contract (C...) addresses");
  }

  const interceptor = new PreFlightInterceptor({
    server: new rpc.Server(RPC_URL),
    networkPassphrase: NETWORK_PASSPHRASE,
    guard: GUARD,
    agent: Keypair.fromSecret(agentSecret),
    source: Keypair.fromSecret(sourceSecret),
  });

  // 1001 is above the fixture policy's per_tx_cap of 1000, so this transfer is
  // refused before anything is signed for broadcast (the same refusal is
  // recorded in tests/fixtures/integration-evidence.md).
  const decision = await interceptor.check({
    contract: TOKEN,
    fn: "transfer",
    args: [
      nativeToScVal(GUARD, { type: "address" }),
      nativeToScVal(RECIPIENT, { type: "address" }),
      nativeToScVal(1_001n, { type: "i128" }),
    ],
  });

  console.log(decision.kind === "blocked" ? `blocked: ${decision.reason}` : decision.kind);
}

await runQuickstart();
```

Expected output — 1001 exceeds the fixture policy's `per_tx_cap` of 1000; the
same refusal is recorded in
[`tests/fixtures/integration-evidence.md`](tests/fixtures/integration-evidence.md):

```text
blocked: per_tx_cap_exceeded
```

The enforced simulation signs the agent auth entry and reads a funded source
account, so two testnet secrets are required; the verdict itself spends nothing.
The fixture's secrets are not published — [`npm run deploy:phase2`](docs/installation.md)
provisions your own instance, or use the keys for the instance you are
integrating.

**Next steps:** [signing and submission](docs/concepts/custom-account-signing.md) ·
[heartbeat](#keep-the-dead-man-switch-alive-startheartbeat) ·
[framework adapters](#framework-middleware-langchain--elizaos) ·
[agent runtime support](docs/runtime-support.md).

### Installation

```bash
npm install stellar-agent-guard-sdk
```

> **Module Format & Environment Note:**
> `stellar-agent-guard-sdk` is published strictly as **pure ESM** (`"type": "module"`) targeting **Node.js >= 24.0.0** (declared in `engines`).
>
> If your project or toolchain runs in CommonJS (e.g. legacy LangChain setups, Jest configs, or `.cjs` scripts), load the SDK using the dynamic `await import()` pattern:
>
> ```javascript
> // CommonJS (.cjs or package without "type": "module")
> async function run() {
>   const { PreFlightInterceptor, CostPreChecker } = await import("stellar-agent-guard-sdk");
>   // use interceptor, cost pre-checker, etc.
> }
> ```
>

The full tested matrix — Node version, ESM/CJS behaviour, browser and bundler
targets, plus the environments that are explicitly unsupported — is in
[`docs/runtime-support.md`](docs/runtime-support.md).

*(Or build locally from source with Node 24+)*

```bash
git clone https://github.com/aigbagbobila/stellar-agent-guard-sdk.git
cd stellar-agent-guard-sdk
npm ci
npm run build
```

### Live testnet suite (`.env.phase2`)

The unit suite needs no credentials. The **live** suite (`npm run test:integration`)
runs real transactions against the deployed Phase 2 testnet instance and reads
its signing keys from a gitignored `.env.phase2`. Start from the committed
template, which documents every key and what each one unlocks without carrying a
value:

```bash
cp .env.phase2.example .env.phase2   # then fill in the values
npm run deploy:phase2                # or provision a fresh instance and write it for you
npm run test:integration
```

`tests/integration/harness.ts` validates the file up front. When it is
incomplete it fails once with **every** missing key named — not one key per run,
which would make setup a guessing game of five round trips:

```
.env.phase2 is incomplete: 3 required key(s) are missing:
  - PHASE2_ADMIN_SECRET
  - PHASE2_RECIPIENT_SECRET
  - PHASE2_OUTSIDER_SECRET

Copy the documented template and fill it in:  cp .env.phase2.example .env.phase2
Or provision a fresh instance (writes the file, including PHASE2_ISSUER_SECRET):  npm run deploy:phase2
```

The required keys are `PHASE2_GUARD`, `PHASE2_TOKEN`, `PHASE2_ADMIN_SECRET`,
`PHASE2_AGENT_SECRET`, `PHASE2_RECIPIENT_SECRET` and
`PHASE2_OUTSIDER_SECRET`, plus optionally `PHASE2_RPC_URL`;
`PHASE2_ISSUER_SECRET` is additionally required to (re)deploy. `.env.phase2` is
gitignored (as are all `.env.*` values files — only `*.example` templates are
committable); never commit the filled-in copy.

### Pre-flight Policy Interception

```ts
import { Keypair, rpc } from "@stellar/stellar-sdk";
import { PreFlightInterceptor, isContractAddress, type ContractAddress } from "stellar-agent-guard-sdk";

// Validate contract address from environment
const guardAddress = process.env.GUARD_ADDRESS;
if (!isContractAddress(guardAddress)) {
  throw new Error(`Invalid guard contract address: ${guardAddress}`);
}

// For known hardcoded addresses, use type assertion
const contractAddress = "CDCYDGBGS5AZ5BZS6XY2SK2PHJHSOEGTN3N4INCK34KF6GU2BGC7Z6MB" as ContractAddress;

const interceptor = new PreFlightInterceptor({
  server: new rpc.Server("https://soroban-testnet.stellar.org"),
  networkPassphrase: "Test SDF Network ; September 2015",
  guard: guardAddress, // Type-safe: validated as ContractAddress
  agent: Keypair.fromSecret(process.env.AGENT_SECRET!),
  source: Keypair.fromSecret(process.env.SOURCE_SECRET!),
});

const decision = await interceptor.check({
  contract: contractAddress,
  fn: "transfer",
  args: [/* from, to, amount */],
});

if (decision.kind === "admissible") {
  console.log("Allowed! Resource fee:", decision.estimatedResourceFee);
} else if (decision.kind === "blocked") {
  console.log("Blocked by guard:", decision.reason);
} else {
  console.log("Undetermined (fails closed)");
}
```
#### Adapter verdict handling

Both framework adapters wrap the same `PreFlightInterceptor` but expose different contracts, so the same verdict maps to different observable behavior per adapter. The table below is the source of truth enforced by the shared adapter test harness (`tests/integration/adapters.test.ts`); each row is one adapter × one verdict, and the expected-behavior columns differ only where the adapter contracts say they differ.

| Verdict | LangChain (`createLangChainGuardMiddleware`) | ElizaOS (`createGuardValidator`) |
|---|---|---|
| `admissible` | Passes through; the wrapped tool handler runs. | Returns `true`; the action is a candidate for execution. |
| `blocked(reason)` | Halts the tool call and returns a `ToolMessage` carrying the contract `reason` and explanation; the tool handler never runs. | Returns `false`; the action is excluded from candidate execution. |
| `undetermined(cause)` | Halts the tool call with a formatted `ToolMessage` (fails closed); the tool handler never runs. | Returns `false` (fails closed); the action is excluded from candidate execution. |
| Mapping failure (`toContractCall`/`toContractCalls` throws or returns a malformed call) | Halts with an error `ToolMessage` describing the mapping failure (reported to `onMappingError`, then to `onBlocked` as `undetermined`); the tool handler never runs. | Returns `false`; the action is excluded from candidate execution. |
| Not fund-moving (`toContractCall` returns `null`) | Passes through untouched: `null` means "no funds move", not "allowed", so no verdict is invented. | Returns `true` for the same reason; the guard has no opinion. |

Adapter callbacks (`onDecision`, `onBlocked`, `onMappingError`) are never awaited. A callback that throws, or returns a promise that rejects, is isolated — it is reported to the optional `blockedHookLogger` and can never resume a halted action or become an unhandled rejection (issue #313). Every adapter also accepts `signal` and `timeoutMs`, which are forwarded to the pre-flight check; an abort or a fired timeout yields the same fail-closed `undetermined` halt as any other enforcement failure (issue #315). `timeoutMs` defaults to the exported `DEFAULT_ADAPTER_TIMEOUT_MS`, and the LangChain adapter also merges a `RunnableConfig.signal` into its cancellation bound (issue #454).


#### Branded Address Types (v0.2.0+)

This version introduces **branded types** to distinguish contract addresses (C...) from account addresses (G...) at compile time, preventing a common source of bugs where an address is used in the wrong context.

**Type Guards:**

```ts
import {
  isContractAddress,    // Validates C... addresses
  isAccountAddress,     // Validates G... addresses
  isStrKeyAddress,      // Validates any StrKey (C... or G...)
  isPublicKeyHex,       // Validates 64-char hex public keys
} from "stellar-agent-guard-sdk";

// Runtime validation before use
if (!isContractAddress(userInput)) {
  throw new Error("Expected contract address (C...)");
}
```

**Migration:** If upgrading from an earlier version, see [MIGRATION.md](./MIGRATION.md) for guidance on updating your code to use typed addresses.

#### Branded Address Types (v0.2.0+)

This version introduces **branded types** to distinguish contract addresses (C...) from account addresses (G...) at compile time, preventing a common source of bugs where an address is used in the wrong context.

**Type Guards:**

```ts
import { 
  isContractAddress,    // Validates C... addresses
  isAccountAddress,     // Validates G... addresses
  isStrKeyAddress,      // Validates any StrKey (C... or G...)
  isPublicKeyHex,       // Validates 64-char hex public keys
} from "stellar-agent-guard-sdk";

// Runtime validation before use
if (!isContractAddress(userInput)) {
  throw new Error("Expected contract address (C...)");
}
```

**Migration:** If upgrading from an earlier version, see [MIGRATION.md](./MIGRATION.md) for guidance on updating your code to use typed addresses.

#### Throw vs. Verdict Contract

The same doctrine extends to adapter construction: **misconfiguration throws at construction; blocked actions return/throw as documented.** Adapter factories (`createLangChainGuardMiddleware`, `createGuardValidator`) validate their options synchronously before returning, so a missing `toContractCall`, an interceptor lacking a `check` method, or an empty options object fails fast at setup — never mid-loop on the first live tool call. See [Adapter options validation](#adapter-options-validation-fail-fast-at-construction) below.

Pre-flight policy interception makes an intentional asymmetric distinction between programmer errors and policy outcomes:

- **Input validation throws `InvalidInputError` (synchronous)**: If a `ContractCall` is malformed (invalid StrKey contract ID, missing or non-symbol-shaped function name, invalid arguments array, or non-`i128` amount), `interceptor.check()` throws `InvalidInputError` synchronously without dispatching any network RPC request.
- Callers requiring a throw-on-refusal flow can use `interceptor.assertAllowed(call)` (or `assertBatchAllowed(calls)`), which throws `GuardBlockedError` on `blocked` and `GuardUndeterminedError` on `undetermined` or transport failures.

##### Verdict × Outcome Matrix

| Pre-flight verdict / condition | `check(call)` outcome | `assertAllowed(call)` outcome | Notes |
| :--- | :--- | :--- | :--- |
| **Admissible** | Returns `{ allowed: true, kind: "admissible", ... }` | Returns `PreFlightDecision & { allowed: true }` | Green light; tool/call permitted. |
| **Blocked** (`reason`) | Returns `{ allowed: false, kind: "blocked", reason, ... }` | Throws `GuardBlockedError` | Policy refusal (cap, recipient, pause, etc.); inspect `.reason`, `.code`, `.call`. |
| **Undetermined** | Returns `{ allowed: false, kind: "undetermined", detail, error? }` | Throws `GuardUndeterminedError` | Fail-closed: guard could not evaluate (e.g. unpriceable fee); underlying `.cause` preserved. |
| **Transport / Network Error** (generic `Error`) | Returns `{ allowed: false, kind: "undetermined", ... }` | Throws `GuardUndeterminedError` | Raw transport error never escapes; wrapped with original error preserved on `.cause`. |
| **Invalid Input** (malformed call) | Throws `InvalidInputError` | Throws `InvalidInputError` | Programmer error: synchronous validation failure, zero RPC round-trips. |

### Adapter options validation (fail-fast at construction)

Adapter factories validate their options **synchronously at construction time**, before any action runs. A misconfigured adapter throws a typed `GuardError` (subclass `AdapterConfigError`) naming the offending field and its expected shape — it never surfaces as a mid-loop failure on the first production tool call.

### Fidelity & limits

Pre-flight simulation is a prediction made against one ledger snapshot, not a settlement guarantee. Four limits are known — window state moving between `check` and broadcast, the fee market moving, simulation not executing return-value-dependent effects, and approximated batch semantics — plus the opt-in cache's staleness caveat.

Each one is spelled out, with the implementing function, the test that pins it, the residual risk and what to do instead, in [Simulation fidelity: decision table](docs/api/interceptor.md#simulation-fidelity-decision-table). Two are unfixable client-side: a third-party spender can move the window, and the fee market can move before broadcast — both can be bounded but never eliminated. Batch atomicity needs a contract-side `check_batch`.

### Optional simulation-result cache

`PreFlightInterceptor` always performs a fresh simulation by default. For agent
loops that repeatedly check the same call, caching can be enabled explicitly:

```ts
const interceptor = new PreFlightInterceptor({
  server,
  networkPassphrase,
  guard,
  agent,
  source,
  cache: {
    ttlLedgers: 1, // maximum one approximate five-second ledger window
    maxEntries: 256, // bound distinct call fingerprints held at once
    policyRevision: () => readPolicyRevision(),
  },
});

const first = await interceptor.check(call);
const second = await interceptor.check(call); // may reuse the first verdict
interceptor.invalidate();                       // clear all entries
interceptor.invalidate(call);                  // clear one call's entries
```

The cache is **disabled unless `cache` is supplied**. It stores only actual
`admissible` and `blocked` decisions; transient `undetermined` results are not
cached. A cache key includes the contract, function, canonical XDR argument
fingerprint, interceptor identity, and the supplied policy revision. The cache
is discarded when the observed ledger advances, when the TTL expires, or when
`invalidate()` is called. `ttlMs` and `ttlLedgers` are both capped at one
approximate ledger-close interval; if both are supplied, `ttlMs` takes
precedence.

`maxEntries` bounds the cache's cardinality. When it is full, storing a new
call fingerprint evicts the **least-recently-used** entry (a cache hit refreshes
recency), so an agent making many distinct calls cannot grow the cache without
limit. Eviction only removes entries; a lookup still requires a current-ledger,
unexpired entry, so a bounded cache can never serve an expired or cross-ledger
verdict — the worst it does is force a fresh simulation for a recently cached
fingerprint. Omit `maxEntries` for the previous unbounded behaviour.

A **cached verdict can be staler than one admitted transfer**. The rolling spend
window can change after a simulation while a cached result is still being
reused, so callers that cannot tolerate that tradeoff should leave caching off,
use a shorter TTL, provide a policy revision, and invalidate after policy or
account-state changes.

### Cost Pre-Checking with Policy Context

```ts
import { CostPreChecker } from "stellar-agent-guard-sdk";

const checker = new CostPreChecker({
  interceptor,
  maxFeeStroops: 50_000n,
  policySource: "CAPADGEK457RHKN4RYVUMDJTFHDSG7R5HREQONKLYK7MFKC5WFENPP44", // opt-in policy source
});

const result = await checker.check({
  contract: "CDCYDGBGS5AZ5BZS6XY2SK2PHJHSOEGTN3N4INCK34KF6GU2BGC7Z6MB",
  fn: "transfer",
  args: [/* from, to, amount */],
});

console.log("Cost verdict:", result.kind); // within_budget | over_budget | blocked | undetermined
console.log("Policy context:", result.policyContext);
```

#### Policy Context Semantics

When an opt-in `policySource` (contract address or `GuardPolicy`/`PolicyConfig`) is configured in options, `CostPreCheckResult` exposes additive `policyContext`:

- `perTxCapOk`: Whether the transaction fits within the policy's per-transaction cap (`true` if within cap, `false` if `per_tx_cap_exceeded`, or `null` if not determinable).
- `windowRemainingEstimate`: Estimated remaining budget in the current rolling window. **Always `null` when the contract does not expose sufficient window state.**
  > `null` means "not available / cannot be determined from the current contract state", not "zero remaining budget". The SDK never fabricates a zero budget.
- `reason`: The contract's policy block reason (e.g. `"window_cap_exceeded"` or `"per_tx_cap_exceeded"`), or `null` when allowed.
- When no policy source is configured in options, `policyContext` is `null` (no policy call is made).

### Injectable transport (`server` or `url`)

Every RPC-facing surface — `PreFlightInterceptor` / `preflight()`, `invoke()` /
`enforceCall()`, and `GuardTelemetryListener` — takes the same transport shape
(`RpcTransportConfig`): supply **exactly one** of

- `server` — a pre-built `rpc.Server`, used verbatim. The SDK never replaces it
  with a fresh one.
- `url` — a Soroban RPC URL. The SDK builds `new rpc.Server(url, rpcOptions)`;
  `rpcOptions` is optional and passed through unchanged.

Supplying both, or neither, throws `InvalidInputError` (a `TypeError`, rules
`server-url-mutually-exclusive` / `server-or-url-required`) at construction,
before any RPC. A telemetry listener used only for local state (counters,
`recent()`, no `guard`) needs no transport.

```ts
import { rpc } from "@stellar/stellar-sdk";
import { PreFlightInterceptor } from "stellar-agent-guard-sdk";

// Proxy / auth setup happens *before* the Server is constructed, then it is passed in.
const server = new rpc.Server("https://rpc.example.com", {
  headers: { Authorization: `Bearer ${process.env.RPC_TOKEN}` },
});
const guard = new PreFlightInterceptor({ server, networkPassphrase, guard, agent, source });

// Or let the SDK build it from a URL:
const guard2 = new PreFlightInterceptor({ url: "https://soroban-testnet.stellar.org", networkPassphrase, guard, agent, source });
```

What `@stellar/stellar-sdk` 17 supports (from `lib/esm/rpc/server.d.ts`, 17.0.1):

- The constructor is `new rpc.Server(serverURL: string, opts?: rpc.Server.Options)`.
- `rpc.Server.Options` has `allowHttp?: boolean`, `timeout?: number`, and
  `headers?: Record<string, string>`.
- `server.httpClient` (`readonly httpClient: HttpClient`) is exposed; its
  `defaults.headers` and `interceptors.request.use(...)` can be set on an
  instance before it is injected.
- There is **no** custom `fetch` / transport function option in sdk 17, so
  `server` instance injection is the only lever this SDK exposes. mTLS or a
  custom agent must be configured on the instance (or the process) before it is
  passed in.

Unit tests can inject a plain object implementing just the methods a test
exercises (cast to `rpc.Server`) instead of mocking a URL.

### Deterministic time control in tests (Clock injection)

Time-dependent operations (cache TTL, transaction polling) support optional `Clock` injection for deterministic testing without real delays.

**For tests**, use `FakeClock` to control time:

```ts
import { FakeClock, PreFlightInterceptor } from "stellar-agent-guard-sdk";

test("cache entry expires", async () => {
  const clock = new FakeClock(0);
  const interceptor = new PreFlightInterceptor({
    server,
    guard,
    agent,
    source,
    cache: { ttlMs: 5000 },
    clock, // Inject the fake clock
  });

  const decision1 = await interceptor.check(call);

  // Advance clock without real delays
  clock.advance(6000); // Skip to t=6000ms (past the 5000ms TTL)

  const decision2 = await interceptor.check(call); // Cache expired, fresh lookup
});
```

**For production**, no action is needed: modules default to the system clock. The `Clock` interface is purely optional and for testing.

Key methods on `FakeClock`:

- `now()` — returns current time in milliseconds
- `sleep(ms)` — returns a promise (resolves instantly when time allows)
- `advance(ms)` — move the clock forward deterministically
- `setTime(ms)` — set clock to an absolute time

Time-dependent modules (preflight cache, transaction polling) accept an optional `clock` parameter. When omitted, they use the system clock (`Date.now()`, real `setTimeout`). Tests pass a `FakeClock` to eliminate real waits and make timing deterministic. For full guidance, see [CONTRIBUTING.md](CONTRIBUTING.md) under "Deterministic time control in tests".

### Pipeline step observability (`onStep`)

`invoke()` accepts an **optional** `onStep` callback. When omitted, behavior is
exactly as before — the hook is pure observability and writes nothing itself
(what you do with the events is up to you; for the SDK's own diagnostics see
[Optional logging](#optional-logging-the-sdk-is-silent-unless-you-ask)):

```ts
const outcome = await invoke({
  server,
  source,
  call,
  networkPassphrase,
  guardAuth,
  onStep(step) {
    // consumer decides how to display/log the event
    console.log(`[${step.attempt}] ${step.name} ${step.status} in ${step.durationMs}ms`);
  },
});
```

Event shape (`InvokeStepEvent`):

| Field | Meaning |
|---|---|
| `name` | Pipeline stage: `probe` → `sign` → `simulate` → `broadcast` (the shared `TRACE_STEP_NAMES` vocabulary). |
| `status` | `start` (emitted immediately before the stage runs), then `ok` or `fail`. |
| `durationMs` | Elapsed time of **this stage attempt** in milliseconds — not the total `invoke()` duration. Always `0` on `start`. |
| `attempt` | 0-based retry index. `0` for the first pass; `1` on the built-in stale-ledger re-run. Always present. |

The callback is optional, receives every stage attempt (a retried invoke emits
a full `probe → sign → simulate → broadcast` sequence per attempt, each tagged
with its `attempt` index), and **callback exceptions are isolated**: a throwing
`onStep` never breaks the pipeline, never turns a successful invoke into a
failure, and never masks the original pipeline error — callback errors are
swallowed silently, because the callback is the caller's own code and not the
SDK's sink to report through. Step names come from the same shared vocabulary
the dry-run trace uses (`TRACE_STEP_NAMES`), so consumers of either see
identical stage names.

The LangChain adapter exposes the same capability:

```ts
const middleware = createLangChainGuardMiddleware({
  interceptor,
  toContractCall: (request) => (/* ... */),
  onStep(step) {
    // enforcement-stage events (probe → sign → simulate; never broadcast)
  },
});
```

### Optional logging: the SDK is silent unless you ask

A library that prints pollutes its host's logging pipeline — structured logs,
level filtering, redirection — so **the SDK writes nothing by default.** The
audit behind that claim, run for this change: `src/` contained exactly one
`console.*` call, an env-gated debug dump in the invoke pipeline
(`SAG_DEBUG_RESOURCES=1`). It is gone, and its description now goes to an
injected logger, or nowhere. A unit test scans `src/` for console calls and
direct stdout/stderr writes, so a new one fails `npm test` rather than quietly
appearing in a host's output.

What the SDK knows is still available, through an optional `logger` on every
config that has a decision point — `PreFlightInterceptor`, `CostPreChecker`,
`GuardTelemetryListener` and `invoke()`. Pass any object with the four levels;
`console` itself satisfies the interface, as does a pino or winston child
logger. Each call gets a complete message plus optional structured detail, so a
logger that ignores the detail still reads well:

```ts
import { PreFlightInterceptor } from "stellar-agent-guard-sdk";

const interceptor = new PreFlightInterceptor({
  server,
  networkPassphrase,
  guard,
  agent,
  source,
  logger: {
    debug: (message, meta) => log.debug({ ...meta }, message), // stages, cache hits, retries
    info: (message, meta) => log.info({ ...meta }, message), // a guard refusal
    warn: (message, meta) => log.warn({ ...meta }, message), // undetermined, fee ceiling, coverage gap
  },
});

const decision = await interceptor.check(call); // same verdict, same fees — now audible
```

A level the host omits is dropped rather than routed elsewhere, and a level that
throws is isolated: a broken sink cannot turn an admissible verdict into an
error, change a retry count, or fail a broadcast. Logging is observability, and
observability never decides whether a transaction runs. `logger: console` is
the one-liner that restores the removed `SAG_DEBUG_RESOURCES=1` behaviour
deliberately, instead of a library making that choice for its host.

### Framework Middleware (LangChain & ElizaOS)

When deploying fleets of hundreds or thousands of autonomous agents derived from identical templates or scheduled loops, fixed poll intervals (e.g. exactly every 5s) cause all instances to poll RPC nodes in lockstep phase. This creates synchronized traffic spikes (thundering herds) against public Soroban RPC endpoints, triggering aggressive HTTP 429 rate limits and cascade backpressure errors.

`GuardTelemetryListener.watch()` defaults to `jitter: 'full'`, which uniformly randomizes each poll delay in `[intervalMs * (1 - j), intervalMs]` with `j = 0.2` (a 20% variance window). This breaks lockstep fleet synchronization while keeping polling responsive and bounded. Deterministic fixed interval cadence can be restored when needed by specifying `jitter: 'none'`.

```ts
// Follow event telemetry with full jitter (default)
for await (const events of listener.watch({
  pollIntervalMs: 5_000,
  jitter: "full", // uniformly distributed in [4000ms, 5000ms]
})) {
  console.log(`Received ${events.length} guard event(s)`);
}
```

### Backpressure in `watch()` (bounded look-ahead)

`watch()` never runs ahead of its consumer without a bound. At most
`maxBufferedPages` pages (`DEFAULT_MAX_BUFFERED_PAGES`, `2`, by default) are
prefetched between the poll loop and your `for await` body, plus at most one
request in flight, and the pump pulls sequentially — never more than one
`getEvents` at a time. A consumer that processes slower than the poll cadence
(a dashboard render loop, a file logger) therefore **throttles the fetches**
instead of letting the stream race ahead with pages nobody has consumed — no
unbounded memory growth, no unconsumed rate-limit burn. A consumer that stops
pulling stops the fetches once the bound is reached.

```ts
for await (const events of listener.watch({
  maxBufferedPages: 0, // strict consumer-paced polling: one page fetched per pull
})) {
  await slowRender(events); // the next fetch waits for you
}
```

The bound changes pacing, never what you receive: same order, no loss, no
duplicates. Cursors are saved **when a page is delivered**, so the stored cursor
never leads your position — pages fetched but not yet delivered when you stop
are re-read after a restart (at-least-once, never lose-the-tail). An invalid
bound (non-integer or negative) throws a `TypeError` when the stream starts,
before any RPC is issued.

### Aborting a watch: what cancellation does and does not cover

`watch({ signal })` ends the stream — aborting is a normal exit, never a throw.
Abort is honoured at **loop boundaries**: before the first request (an
already-aborted listener issues no RPC call at all, not even the
`getLatestLedger` probe that resolves a default `startLedger`), before each
poll, and during the delay between polls. The default delay's timer is cleared
on abort, so a stopped listener leaves no open handle behind for a Node process
or a test suite to hang on.

```ts
const controller = new AbortController();
for await (const events of listener.watch({ signal: controller.signal })) {
  handle(events);
}
// Runtime teardown, a new tool call, or a shutdown hook:
controller.abort(); // the loop ends, and no further getEvents is issued
```

**One limitation, stated rather than papered over: a request already in flight
is not cancelled.** `@stellar/stellar-sdk` ^17 (the version this package
depends on, `dependencies` in `package.json`) declares
`getEvents(request: Api.GetEventsRequest)` with no `AbortSignal` parameter, and
its internal JSON-RPC `postObject` helper takes no per-request config, so there
is no supported way to plumb a signal through to the socket. The listener
consequently stops *issuing* requests immediately but cannot cancel one already
sent — and it does not wait for it either: aborting ends the iterator right
away, even while a `getEvents` call is pending, and a response that arrives
after teardown is discarded rather than delivered. The rejection of that
in-flight request (or of an abort-aware `sleep`) is swallowed as teardown, so an
aborted watch ends quietly in a `for await` loop instead of surfacing an
`AbortError` or an unhandled rejection.

Revisit this when the SDK adds per-request signals to `getEvents`; until then,
read `signal` as *stop soon and stop asking*, not *cancel the socket*.

### Bounding a check or an invoke (`signal` and `timeoutMs`)

`check()`, `checkBatch()`, `CostPreChecker.check()` and `invoke()` each accept
two optional caller-owned bounds on the RPC calls they make:

- `signal?: AbortSignal` — your runtime's cancellation (a tool-loop deadline, a
  shutdown hook, a user's "stop"). An **already-aborted** signal returns before
  any RPC call is issued. On a batch it stops the batch: no further call is
  started, and every unfinished call is reported as fail-closed `undetermined`.
- `timeoutMs?: number` — a per-RPC-call budget in milliseconds. It defaults to
  `DEFAULT_RPC_TIMEOUT_MS` (**30s**), because a network partition that leaves a
  guardrail call pending forever is a hang, not a fail-closed decision. Pass
  `timeoutMs: 0` to opt out and rely on `signal` alone.
- `deadlineMs?: number` — **`invoke()`**: one overall budget for the whole
  action. Expiry is fail-closed and reported as an `RpcTimeoutError` with
  `deadline: true`; it can never become an `allowed` outcome. Pass `clock` to
  make the accounting deterministic in tests. See `docs/api/invoke-pipeline.md`.
  `checkBatch()` enforces it as one absolute budget for the whole batch: once it
  is spent, no further call starts and every unfinished call is a fail-closed
  `undetermined` verdict carrying an `RpcTimeoutError` with `deadline: true`.

**Concurrent identical checks are coalesced.** `PreFlightInterceptor` shares one
in-flight discovery/enforcement run when the same call and config are checked at
the same time, so an agent framework issuing duplicate tool checks in one
planning turn does not pay for duplicate RPCs. This is not a cache: the entry is
removed as soon as the run settles, including on failure or `undetermined`. Each
waiter still applies its own `signal`/`timeoutMs` — one caller giving up never
cancels a result another waiter is entitled to — while the shared run itself
keeps the pipeline's default `DEFAULT_RPC_TIMEOUT_MS` bound. Checks that supply
`onStep` keep their own run so each trace sees every event, and
`coalesceInFlight: false` disables coalescing entirely.

**The typed error is the same; where it surfaces is deliberately not.** A bound
that fires raises one class, `RpcTimeoutError` (carrying `stage` and whether it
was an `aborted` signal or a timeout), but the entry points answer different
questions:

| Call | Fired bound |
| --- | --- |
| `check()` / `CostPreChecker.check()` | the fail-closed `undetermined` **verdict** (`decision.error instanceof RpcTimeoutError`) — the guard reached no decision, which is what `undetermined` already means |
| `checkBatch()` | `undetermined` verdicts for the call in flight and for every call that never started; the completed verdicts keep their own kind |
| `invoke()` | `invoke`'s `error` **outcome** (`outcome.error instanceof RpcTimeoutError`) — the pipeline never reached broadcast |

```ts
const decision = await interceptor.check(call, { timeoutMs: 5_000 });
if (decision.kind === "undetermined" && decision.error instanceof RpcTimeoutError) {
  // Fail closed: the guard could not be reached in time.
}
```

Branch on the class, never on `detail`.

**One limitation, stated rather than papered over: the request itself is never
cancelled.** `@stellar/stellar-sdk` ^17's `Server` methods take no
`AbortSignal`, so the SDK races the in-flight promise against your signal and
the timeout. The HTTP request therefore continues server-side until it completes
or the connection drops; the bound cancels *your wait*, not the socket. What it
changes is bounded: a fired bound can only stop the SDK from waiting — it can
never relax a verdict, a cap or a block reason, and a call that is neither
aborted nor timed out behaves exactly as it did before.

### Framework Middleware (LangChain & ElizaOS)

Plug-and-play middleware intercepts agent actions before tools are executed:

- **Framework adapters**:
  - LangChain: [`createLangChainGuardMiddleware`](docs/examples/langchain.md) wraps tool calls using `AgentMiddleware.wrap_tool_call`. If the guard refuses (`blocked`) or the verdict is `undetermined`, execution is halted client-side with a formatted `ToolMessage` carrying the contract reason code and explanation (fails closed). The tool handler never runs, avoiding network submission fees. See the [full runnable LangChain example](docs/examples/langchain.md) ([`examples/langchain.ts`](examples/langchain.ts)).
  - ElizaOS: [`createGuardValidator`](docs/examples/elizaos.md) and [`guardAction`](docs/examples/elizaos.md) compose pre-flight simulation into `Action.validate`. Refused (`blocked`) and `undetermined` actions both return boolean `false` (fails closed), excluding them from candidate execution. See the [full runnable ElizaOS example](docs/examples/elizaos.md) ([`examples/elizaos.ts`](examples/elizaos.ts)).
  - MCP: [`guardMcpToolHandler`](docs/examples/mcp.md) wraps a Model Context Protocol tool handler (`registerTool` / `tool` / `setRequestHandler(CallToolRequestSchema)`), and [`guardMcpCallTool`](docs/examples/mcp.md) wraps a client's `callTool` before the request leaves the process. A refusal is returned as an `isError: true` result and the tool body never runs. See [the MCP integration example](docs/examples/mcp.md).
  - Vercel AI SDK: [`createVercelAIGuard`](docs/api/framework-adapters.md#vercel-ai-sdk) wraps a tool's own `execute` function — the earliest pre-execution point the `ai` package exposes. `admissible` → the tool runs; `blocked` → `GuardBlockedError` thrown before `execute`; `undetermined` → `PreFlightUndeterminedError` thrown before `execute` (fail-closed, matching the other adapters' refusal behavior). Crucially, `execute` never runs on a refusal. Written structurally against the `Tool` shape, so `ai` stays an optional peer, not a dependency. See the [full runnable Vercel AI SDK example](examples/vercelai.ts) ([`examples/vercelai.ts`](examples/vercelai.ts)).

#### Operator alerting on every halt (`onBlocked`)

A refusal is visible to the agent (its tool result says so), but not to the human watching dashboards — telemetry is a separate opt-in. Every adapter takes an optional `onBlocked` callback that fires once per halt, so a refusal can be wired to a webhook, log, or alert channel:

```ts
const middleware = createLangChainGuardMiddleware({
  interceptor,
  toContractCall,
  onBlocked: ({ adapter, kind, reason, call, explanation }) => {
    console.warn(`[${adapter}] ${kind}: ${reason ?? "undetermined"} on ${call.fn} — ${explanation}`);
  },
});
```

The payload is the same on every adapter (`{ adapter, kind, reason, call, explanation }`): `kind` is `"blocked"` when the guard refused and `"undetermined"` when enforcement could not decide (in which case `reason` is `null` and `explanation` carries the failure detail — the halt still happens, because the adapter fails closed). The callback is called *after* the halt is decided and its errors are swallowed, so a broken alerting sink can never turn a refusal into an executed action or a thrown error. A swallowed hook failure is silent by default; pass `blockedHookLogger: { error(...) }` when you want that diagnostic. Omit `onBlocked` for exactly the pre-existing behavior.

A guard refusal and a broken mapper both halt, but they are not the same event. Every adapter also accepts `onMappingError`, which fires only when `toContractCall`/`toContractCalls` throws or returns a malformed call, immediately before the fail-closed halt (`onBlocked` still fires afterwards for compatibility). Its payload is `{ adapter, tool, errorClass, error }`; the raw request — and therefore the tool arguments — is included only when `includeMappingErrorRequest: true`, so a remote sink does not receive secrets by default.

#### Ordered call batches (`toContractCalls`)

A tool that performs several guarded contract calls can map the whole action with the additive `toContractCalls` mapper instead of `toContractCall`. The complete ordered batch is checked before the handler runs; if any call is blocked or undetermined, the action is refused and no handler side effect occurs (all-or-nothing). `onDecision` receives every per-call verdict in order, and a batch halt's `onBlocked` payload also carries `calls` and `verdicts`:

```ts
const middleware = createLangChainGuardMiddleware({
  interceptor,
  toContractCalls: (request) => [approveCall, swapCall],
  onDecision: (_request, verdict) => report(verdict.kind),
  onBlocked: ({ calls, verdicts }) => alert(`${verdicts.length} calls checked; refused`),
});
```

`toContractCalls` returns `null` or `[]` for a tool that moves no funds, and takes precedence over `toContractCall` when both are supplied.

> **ElizaOS note (0.2.x):** the ElizaOS adapter previously passed the raw `PreFlightDecision` to `onBlocked`; it now receives this structured payload, matching LangChain and MCP. Read `info.reason` / `info.explanation` (or `info.kind`) instead of `decision.reason` / `decision.explanation`.

### Start from the safe baseline (`DEFAULT_GUARD_POLICY`)

Rather than re-typing a policy literal, start from the SDK's frozen, deny-all baseline and add only what your agent needs:

```ts
import { DEFAULT_GUARD_POLICY, policyToScVal, validateGuardPolicy, type ReadonlyPolicyConfig } from "stellar-agent-guard-sdk";

const policy: ReadonlyPolicyConfig = {
  ...DEFAULT_GUARD_POLICY,
  assets: [TOKEN],         // the one SAC token the agent may move
  recipients: [RECIPIENT], // the one destination it may pay
};
validateGuardPolicy(policy); // []
const scVal = policyToScVal(policy);
```

| Field | Baseline | Rationale |
| --- | --- | --- |
| `assets` / `recipients` / `protocols` | empty | deny-all: nothing is admissible until you name an asset and a recipient |
| `per_tx_cap` | `100n` | small single-transfer ceiling (the contracts `max-security` template's value) |
| `window_secs` / `window_cap` | `3600n` / `500n` | one hour, at most five full-size transfers (same template) |
| `dms_grace_secs` | `604800n` (7 days) | dead-man switch **on**; SPEC §5 production guidance is "≥ several days", and 7 days is the `watch-only` template's grace |

The constant is deep-frozen (mutating it throws), and a unit test asserts its values still match the vendored contracts templates. On its own it reports exactly two `empty_vector_noop` findings (`assets`, `recipients`) — the deny-all intent made visible, cleared as soon as you add one of each. The numbers are a starting point, not a recommendation for your risk limits. The inline policy literals in the validation and encode sections below are deliberate: they demonstrate *invalid* or *edge-case* drafts, which a safe baseline cannot.

### Policy validation before broadcast (validateGuardPolicy)

Before encoding and submitting a policy on-chain, validate it client-side with `validateGuardPolicy`.
This provides a **fail-before-broadcast** safety rail that catches configuration errors before burning transaction fees or facing on-chain contract rejections.

Unlike fail-fast validators, `validateGuardPolicy` returns **all** failures at once (`PolicyFailure[]`), which is critical for dashboard form UX where an operator needs to see all field-level issues simultaneously. The failure `rule` identifiers align with SPEC §8 rules:

```ts
import {
  validateGuardPolicy,
  type PolicyConfig,
  type PolicyFailure,
} from "stellar-agent-guard-sdk";

const draftPolicy: PolicyConfig = {
  per_tx_cap: 10_000n,
  window_secs: 0n,         // Incompatible with window_cap > 0
  window_cap: 50_000n,
  assets: [],              // Empty assets vector is a no-op
  protocols: [],
  recipients: ["GAOBCRXTCO4ZCBNHALJUMJJ5JDXNOUZ7U6VZJX4UBTXAHQEO66IPU6PH"],
  allow_any_recipient: false,
  active_from: 1000n,
  active_until: 500n,      // Inverted active window (active_until <= active_from)
  paused: false,
  dms_grace_secs: 0n,
};

const failures: PolicyFailure[] = validateGuardPolicy(draftPolicy, {
  guardAddress: "CAPADGEK457RHKN4RYVUMDJTFHDSG7R5HREQONKLYK7MFKC5WFENPP44",
});

if (failures.length > 0) {
  for (const failure of failures) {
    console.error(`[${failure.rule}] at ${failure.field}: ${failure.message}`);
  }
  // Safe-exit before encode or broadcast
} else {
  // Proceed with policyToScVal(draftPolicy) and broadcast
}
```

#### Loading a policy from a JSON file (Node only)

Script and cron integrations keep policy as JSON, so `stellar-agent-guard-sdk/fs`
reads, parses and validates a file in one call. The subpath is the only place the
SDK touches `node:fs`; the root import stays browser-safe. Each failure mode is a
distinct typed error, so a shell script can branch on the cause:

```ts
import { PolicyFileReadError, PolicyValidationError } from "stellar-agent-guard-sdk";
import { loadPolicyFromFile } from "stellar-agent-guard-sdk/fs";

try {
  const policy = await loadPolicyFromFile("policy.json");
  // `policy` is a validated GuardPolicy ready for policyToScVal()/broadcast.
} catch (error) {
  if (error instanceof PolicyFileReadError) {
    console.error(`cannot read ${error.path} (${error.code})`);
  } else if (error instanceof PolicyValidationError) {
    // Every SPEC §8 failure, not just the first.
    for (const failure of error.failures) console.error(failure.rule, failure.path);
  } else {
    throw error; // PolicyDecodeError: invalid JSON or policy shape
  }
}
```

### Policy encode/decode round trip

`decodePolicy` is the canonical read-side counterpart to `policyToScVal`. It returns
`bigint` for every integer field, keeps `ProtocolRule.fns: null` distinct from an empty
array, normalizes Stellar addresses, and rejects missing, duplicate, unknown, unsorted, or
wrongly typed fields with a path-bearing `PolicyDecodeError`.

```ts
import {
  decodePolicy,
  policyToScVal,
  type PolicyConfig,
} from "stellar-agent-guard-sdk";

const policy: PolicyConfig = {
  per_tx_cap: 1_000n,
  window_secs: 60n,
  window_cap: 150n,
  assets: ["CDCYDGBGS5AZ5BZS6XY2SK2PHJHSOEGTN3N4INCK34KF6GU2BGC7Z6MB"],
  protocols: [
    {
      contract: "CDCYDGBGS5AZ5BZS6XY2SK2PHJHSOEGTN3N4INCK34KF6GU2BGC7Z6MB",
      fns: ["transfer"],
    },
  ],
  recipients: ["GAOBCRXTCO4ZCBNHALJUMJJ5JDXNOUZ7U6VZJX4UBTXAHQEO66IPU6PH"],
  allow_any_recipient: false,
  active_from: 0n,
  active_until: 0n,
  paused: false,
  dms_grace_secs: 0n,
};

const encoded = policyToScVal(policy);
const decoded = decodePolicy(encoded); // exactly equal to policy
```

The decoder accepts the direct `ScVal::Map` returned by the deployed `policy()` read and
also the one-element `Vec` representation used by some RPC/host surfaces for
`Some(PolicyConfig)`. `ScVal::Void` means no policy is installed and therefore throws
rather than fabricating a default-deny config. Canonical u64/i128 variants are range
checked exactly; base-10 `ScVal::String` integers are accepted as a deliberate
compatibility path for stringly-typed RPC/telemetry payloads and normalized to `bigint`.

### Debug a blocked transfer with `invoke({ dryRun: true })`

Dry run executes the real probe, authorization signing, and enforced-simulation path,
then returns the verdict, diagnostics, network-derived fees, and per-stage timings. It
stops before final transaction assembly and cannot call `sendTransaction`, so its result
has no transaction hash or submission object.

```ts
import { invoke } from "stellar-agent-guard-sdk";

const debug = await invoke({
  server,
  source,
  call: blockedTransferCall,
  networkPassphrase,
  guardAuth: { guard, agent },
  dryRun: true,
});

if (debug.kind === "dry_run") {
  console.log({
    admissible: debug.admissible,
    verdict: debug.verdict,
    reason: debug.reason,
    fees: debug.fees,
  });
  console.table(debug.steps);
}
```

A blocked or undetermined dry run reports an explicit all-zero **charged** fee breakdown;
an admissible dry run reports the simulation's resource fee plus the SDK's 100-stroop
inclusion floor. Missing, negative, malformed, unsafe-number, or out-of-u64-range fee
payloads are `ContractResponseError` failures and remain undetermined—never free.
`steps[].ok` describes whether a stage completed, not whether policy approved the call;
the separate `verdict` field is the policy answer. The `probe → sign → simulate` stages
are measured through the same `onStep` hook a live invocation uses, so a dry-run trace
and an `onStep` trace are the same measurement of the same code.

### Troubleshooting agent authentication

`verifyAgentSignature` lets an agent runtime check that a signature belongs to the key it
believes is registered before entering an agent loop. The helper is verify-only: it never
accepts, signs with, stores, or derives a private key. Other SDK APIs continue to accept
caller-created `Keypair` objects for transaction/authorization signing as before.

```ts
import { verifyAgentSignature } from "stellar-agent-guard-sdk";

function signerMatches(
  registeredPublicKey: string | Uint8Array,
  hostSignaturePayload: Uint8Array,
  signature: Uint8Array,
): boolean {
  return verifyAgentSignature(
    registeredPublicKey,
    hostSignaturePayload,
    signature,
  );
}
```

`hostSignaturePayload` must be the exact 32-byte host digest covered by the signature;
the helper verifies those bytes without re-hashing and is not SEP-53 message signing. A
successful result proves only the key/payload/signature relationship—it does not validate
network ID, invocation, nonce, expiration ledger, or transaction freshness.

### Agent halted with an `undetermined` storm (rate-limited RPC)

An agent firing dozens of tool calls at once used to open dozens of simultaneous simulations, trip the RPC provider's rate limit (HTTP 429) and turn the whole burst into `undetermined` verdicts — safe (fail-closed) but useless. `PreFlightInterceptor` now bounds this:

- `maxConcurrentSimulations` (default **4**) caps simulations in flight; the rest queue first-in first-out, and the queue wait counts toward each check's `signal` / `timeoutMs`.
- A 429 waits **once** (the server's `Retry-After` when sent, else `rateLimit.backoffMs`, default 500 ms, never more than `rateLimit.maxBackoffMs`, default 5 s) and retries once. If it is limited again the verdict is `undetermined` with `cause: "rate_limited"` and a `RateLimitedError`.

```ts
const interceptor = new PreFlightInterceptor({
  // …
  maxConcurrentSimulations: 2, // public RPC with a tight limit: lower it
  rateLimit: { backoffMs: 1_000, maxBackoffMs: 5_000 },
});
```

If you still see `cause: "rate_limited"`, **lower** `maxConcurrentSimulations`. On a self-hosted RPC with generous limits, **raise** it (e.g. 16) for lower latency under bursts. The limit is per interceptor, so several interceptors against one RPC multiply it. The cache's ledger read is not counted as a simulation.

### Typed errors and 0.1.x migration

All operational SDK errors share a `GuardError` base. Invalid caller input is the
deliberate exception: `InvalidInputError` (and `InvalidFeeCeilingError`) extend
`TypeError`, keeping programmer errors distinct from transport, signing and policy
failures. The [error catalog](docs/errors.md#error-classes) maps every exported
class to its stage, meaning, retry and fail-closed behaviour, and first fix.
`invoke()` remains result-oriented: inspect `outcome.error` with `instanceof`
when `outcome.kind === "error"`.

```ts
import {
  BroadcastError,
  GuardError,
  SigningError,
  SimulationError,
} from "stellar-agent-guard-sdk";

if (outcome.kind === "error") {
  if (outcome.error instanceof SigningError) {
    console.error("agent signer is wrong or unavailable");
  } else if (outcome.error instanceof SimulationError) {
    console.error("enforcement could not be determined");
  } else if (outcome.error instanceof BroadcastError) {
    console.error("submission failed", outcome.error.transactionHash);
  } else if (outcome.error instanceof GuardError) {
    console.error(outcome.error.message);
  }
}
```

A pipeline stage that throws — a dropped RPC connection, say — is reported the same way:
as `kind: "error"` carrying the original error as the typed error's `cause`, never as a
rejection. A guardrail that could not reach a verdict has no business throwing at its
caller, and the original error object stays reachable for diagnostics.

If ledger state changes after enforced simulation and the included transaction is then
refused by the guard, `invoke()` still returns `kind: "blocked"` with the contract reason
and diagnostics. That charged outcome additionally carries `transactionHash` and
`charged: true`; it is not flattened into a technical `BroadcastError`.

`GuardBlockedError` keeps its published name, message, fields, and `instanceof` behavior
and now extends `GuardError`; `PreFlightUndeterminedError` is an alias of
`GuardUndeterminedError`, not a subclass of `SimulationError`.
The hierarchy, `decodePolicy`, and `verifyAgentSignature` are additive to 0.1.x callers.
The one intentional behavior change is for callers already using `dryRun: true`: the old
success sentinel (`kind: "error"`) is replaced by the structured `kind: "dry_run"` result
documented above. Non-dry-run callers keep their existing outcome shapes.

### Send one heartbeat (`heartbeat`)

The SDK signs and submits the guard's `heartbeat()` itself — the same custom-account authorization path `invoke()` uses — so a TypeScript agent needs no separate tool for its one routine action. This is the primary path; the contracts repo's `agent-tx` Rust binary remains a CLI alternative.

```ts
import { heartbeat, HeartbeatBlockedError } from "stellar-agent-guard-sdk";

try {
  const beat = await heartbeat({ server, guard: GUARD, signer: agentKeypair });
  console.log(beat.transactionHash, beat.ledger, beat.lastHeartbeat, beat.verified);
} catch (error) {
  if (error instanceof HeartbeatBlockedError) {
    // error.reason is "heartbeat_expired" (the switch already fired; an admin must
    // unfreeze) or "admin_frozen"; the message carries the remediation.
  }
  throw error;
}
```

`heartbeat()` resolves only for an accepted heartbeat. It then re-reads `status()` and reports `lastHeartbeat` and `verified` (a non-zero `LastHeartbeat` on a switch that is not expired); a failed re-read yields `verified: false`, never a failure — the transaction already landed. Pass `verify: false` to skip the re-read. Every other outcome throws: `HeartbeatBlockedError` (a refusal), `HeartbeatDryRunError`, or `BroadcastError` for a submitted-but-unconfirmed transaction (check its hash before rebroadcasting). For a long-running agent use `startHeartbeat` below, which schedules these calls.

### Keep the dead-man switch alive (`startHeartbeat`)

An agent that stops heartbeating freezes. `startHeartbeat` schedules the `heartbeat()` calls and makes the failure modes visible instead of silent — an ad-hoc `setTimeout` loop drops a beat on an event-loop stall and turns an RPC blip into an unhandled rejection.

```ts
import { startHeartbeat } from "stellar-agent-guard-sdk";

const hb = await startHeartbeat({
  server,
  guard: GUARD_ID,
  signer: agentKeypair,        // Keypair or AgentSigner
  intervalMs: 30_000,
  maxSkewMs: 2_000,            // tolerated drift before a beat counts as missed
  onBeat: ({ lateMs }) => { if (lateMs > 2_000) alert("heartbeat late"); },
  onError: (error) => logger.error("heartbeat failed", error),
  graceSecs: 150,              // optional pre-read: validated as interval <= grace/3
});

// on shutdown: request cancellation, wait up to 5s for the in-flight beat
const stop = await hb.stop({ timeoutMs: 5_000 });
if (!stop.settled) logger.warn(`heartbeat stop ${stop.reason}`);
```

- The first beat fires immediately, then every `intervalMs` on a fixed cadence — a slow beat surfaces as lateness on the next one instead of pushing the whole schedule. A submission that outlives several slots skips the stale ones instead of firing a catch-up burst.
- A beat later than `maxSkewMs` increments `hb.missedBeats` and is reported as `lateMs` in `onBeat`; each cadence slot skipped while a submission was in flight is counted too. Alert on lateness, not only on failure. `hb.lastBeatAt` is the epoch ms of the last successful beat.
- Every submission rejection goes to `onError`; nothing escapes as an unhandled rejection.
- `stop()` (or the `signal`) tears down cleanly: no beat is sent after it, and by default it resolves once an in-flight beat has settled. `stop()` first aborts the submission context's `signal`; pass `stop({ timeoutMs })` or set `stopTimeoutMs` when a custom transport might not settle, and inspect `{ reason, settled }` on the result.
- When the grace window is readable (`graceSecs`, or a `readPolicy` read), an interval longer than `grace / 3` throws `HeartbeatIntervalError` **before** the first beat; an unreadable policy warns via `onWarning` and starts anyway.
- A beat that would fall in the same wall-clock second as the previous accepted one is skipped client-side; the contract deduplicates independently.
- Every input is validated **before** the scheduler starts: a negative or non-finite `maxSkewMs`, a negative or non-finite `stopTimeoutMs`, a grace window that is not a non-negative safe integer or bigint, a callback that is not callable, or an unusable retry budget is rejected with an error naming the field — before the first beat, and before the grace window is even read from the chain.

#### Bounded retry for a transient outage

A failed heartbeat used to wait for the next fixed interval, so an RPC outage that landed near the grace boundary could freeze the account even after connectivity returned. `retry` adds a bounded, jittered recovery:

```ts
const hb = await startHeartbeat({
  server,
  guard: GUARD_ID,
  signer: agentKeypair,
  intervalMs: 30_000,
  retry: { maxAttempts: 3 },   // opt-in — the default is one attempt per beat
  onWarning: (message) => logger.warn(message),
  onError: (error) => logger.error("heartbeat failed", error),
});
```

- Only a **transport** failure is retried (a `BroadcastError`, an `RpcTimeoutError`, a `SimulationError`). A **policy block is never retried**: the guard made a decision, and hammering a call it has already refused only adds load. An error the SDK cannot classify is reported, not retried.
- The delay before the next attempt is a full-jitter sample of a bounded window, so agents that hit the same outage do not retry in a synchronized herd.
- The attempt that failed and the delay before the next one are announced through `onWarning`; the failure that ends the beat is reported once through `onError`, with the original error. A successful beat reports how many attempts it took in `onBeat`'s `attempt`.

#### Stopping with an in-flight submission

A custom `submit(beat, { signal })` receives an `AbortSignal` that `stop()` aborts before waiting. The default is still graceful: `stop()` waits for the submission promise to settle, so a transport that honours the signal shuts down promptly. If the transport may never settle, bound the wait with `stop({ timeoutMs })` (or `stopTimeoutMs` on `startHeartbeat`); a fired bound returns `{ reason: "timeout", settled: false }`, while a graceful settle returns the in-flight submission's value or terminal error. No deadline is applied unless you ask for one.

The combined heartbeat-loop + pre-flight pattern is tracked as an integration guide in [#74](https://github.com/Stellar-Agent-Guard/stellar-agent-guard-sdk/issues/74).

## API Reference

> **0.x API Policy & Deprecations:** During `0.x`, this package adheres to an **additive-only within minor** policy (`0.1.x` releases are additive and fixes only; breaking changes and deprecation removals occur only at minor boundaries like `0.2.0`). For full policy details, deprecation mechanics, and the tracking table, see [`docs/deprecations.md`](docs/deprecations.md). Release process and versioning checklist: [`docs/releasing.md`](docs/releasing.md).

### Constructor options

One table per options object a public constructor (or `invoke()`) takes. Every default below is the value the code in `src/` applies when the option is omitted; "none" means the feature is off or the value is simply absent. ⚠️ marks options whose setting changes what a verdict can be trusted for: staleness, fail-closed bounds, or a check that is switched off.

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

#### `CheckBatchOptions` (`checkBatch()` / `assertBatchAllowed()`)

| Option | Type | Default | Meaning |
| --- | --- | --- | --- |
| `policy` | `ReadonlyPolicyConfig \| null` | the constructor's `policy`; if that is absent too, a live read of the `Policy` ledger entry | Policy the batch is staged against. ⚠️ A failed or malformed read is never treated as "no cap": any positive SAC transfer in the batch becomes `undetermined`. |
| `initialWindowSpent` | `bigint` | a live read of the `Window` ledger entry; `0n` only when that entry does not exist | Committed spend already in the window. An explicit value (including `0n`) is a trusted caller snapshot. ⚠️ A failed read is not treated as zero: transfers that need it become `undetermined`. |
| `onStep` | `(step: InvokeStepEvent) => void` | none | Forwarded to each call's `check()`. |
| `signal` | `AbortSignal` | none | ⚠️ Forwarded to each call's `check()`: once it fires, every remaining call returns a fail-closed `undetermined` verdict without issuing an RPC. It does **not** bound the initial `Policy`/`Window` ledger reads; supply `policy` and `initialWindowSpent` to avoid them. |
| `timeoutMs` | `number` | `DEFAULT_RPC_TIMEOUT_MS` (30 000 ms), per call | Forwarded to each `check()`; a fired timeout makes that call `undetermined` and the batch continues. |
| `deadlineMs` | `number` (> 0) | none | One absolute budget for the whole batch, measured on the injected `clock`. Once spent, no further call starts and every unfinished call is a fail-closed `undetermined` verdict carrying an `RpcTimeoutError` with `deadline: true`. A batch that exceeds its deadline is never `admissible`. `timeoutMs` stays per-call, capped by the remaining budget. |

#### `CostPreCheckConfig` (`new CostPreChecker(config)`)

The SDK has no separate `CostPreCheckerOptions` type: the constructor takes `CostPreCheckConfig`. Every value is validated at construction.

| Option | Type | Default | Meaning |
| --- | --- | --- | --- |
| `interceptor` | `Pick<PreFlightInterceptor, "check">` | required | Its `check()` supplies both the verdict and the price, from one enforced simulation. ⚠️ If that interceptor has `cache` enabled, the price can come from a cached verdict (up to one ledger / 5 s old). |
| `maxFeeStroops` | `bigint \| string` | none — no ceiling; the price is reported, never objected to | Ceiling on the estimated **total** fee (resource + inclusion). Accepts a non-negative `bigint` or base-10 integer string through the Stellar u64 fee limit. Malformed strings and out-of-range values throw `InvalidInputError`. `0n` / `"0"` is a real ceiling. ⚠️ Omitting it disables the fee check entirely. |
| `networkPassphrase` | `string` | none | Required by `checkTransaction()` to reject a transaction built for a different network. |
| `server` | `rpc.Server` | none | Required by `checkTransaction()` only when no simulation response is supplied. |
| `policySource` | `string \| PolicyConfig \| null` | none — `policyContext` is `null` | Contract address or policy enabling the additive `policyContext`. Informational only: it never changes the cost decision. |
| `policy` | `string \| PolicyConfig \| null` | none | Alias for `policySource`. Per-call values win over constructor values; `policySource` wins over `policy` at each level. |
| `logger` | `GuardLoggerInput` | none — silent | Log sink for the priced verdict and ceiling breaches. Never changes the decision. |
| `windowSnapshot` | `WindowSpendSnapshot \| null` | none — `policyContext.windowRemainingEstimate` is `null` | Ledger-tied window-spend snapshot for the remaining-window estimate. Informational only. An invalid snapshot throws `TypeError` at construction. ⚠️ A `null` estimate means unknown, never "zero budget left". |
| `windowSnapshotMaxAgeLedgers` | `number` | `0` | How many ledgers the snapshot may predate the priced check and still be used. Non-negative safe integer, otherwise `TypeError`. ⚠️ Raising it lets an older snapshot feed the estimate. |

#### `CostPreCheckOptions` (`check(call, options)` / `checkWithCost(call, options)`)

| Option | Type | Default | Meaning |
| --- | --- | --- | --- |
| `policySource` | `string \| PolicyConfig \| null` | the constructor's `policySource` / `policy` | Per-call policy source for `policyContext`. |
| `policy` | `string \| PolicyConfig \| null` | as above | Alias for `policySource`. |
| `maxFeeStroops` | `bigint \| string` | the constructor's `maxFeeStroops` | Per-call ceiling, validated before simulation. `0n` / `"0"` is kept, not treated as omission. |
| `windowSnapshot` | `WindowSpendSnapshot \| null` | the constructor's `windowSnapshot` | Per-call snapshot; an explicit `null` clears the configured one for this check. |
| `signal` | `AbortSignal` | none | ⚠️ Forwarded to the interceptor: a fired signal yields an `undetermined` verdict and therefore an `undetermined` cost decision carrying `RpcTimeoutError`. |
| `timeoutMs` | `number` | `DEFAULT_RPC_TIMEOUT_MS` (30 000 ms) per RPC call | ⚠️ A fired timeout is reported exactly like an abort, never as `within_budget`. `0` disables it. |

#### `GuardTelemetryConfig` (`new GuardTelemetryListener(config)`)

The constructor's parameter is `GuardTelemetryInputConfig | GuardTelemetryLocalConfig` (default `{}`). `GuardTelemetryListenerOptions` in `src/telemetry.ts` declares only `counters` and is not exported from the package entry; use `GuardTelemetryConfig` (`GuardTelemetryInputConfig` is that config with the shared `server` or `url` transport).

| Option | Type | Default | Meaning |
| --- | --- | --- | --- |
| `server` | `rpc.Server` | one of `server` / `url` required for `poll()` / `watch()` / `watchAll()` | Soroban RPC the listener reads events from, used verbatim. Mutually exclusive with `url`. |
| `url` | `string` | — | Soroban RPC URL; the SDK builds the `rpc.Server` (see [Injectable transport](#injectable-transport-server-or-url)). Mutually exclusive with `server`. Also used as `rpcUrl` when `rpcUrl` is not set. |
| `guard` | `string` (`C…`) | required for `poll()` / `watch()` / `watchAll()` | Guard contract to follow. Events from any other contract are dropped and counted, never decoded. |
| `failedTx` | `boolean` | `false` | Scan failed-transaction diagnostics as a third stream. ⚠️ Off means refusals that only appear in failed transactions are not seen by this listener. |
| `rpcUrl` | `string` | none — `url` when given, else the server's own URL | Network identity (host) that scopes cursor-store slots; checked before `server.serverUrl`. ⚠️ Pointing it at a different host than `server` makes the listener load and save a different cursor slot. |
| `logger` | `GuardLoggerInput` | none — silent | Page summaries, coverage gaps, failed or aborted polls. |
| `counters` | `GuardTelemetryCountersOptions` | none — no counter state; `stats()` returns `null` | Opt-in sliding-window allowed/blocked counters (see below). |
| `clock` | `() => number` | `Date.now` | Clock for `counters.windowMs` eviction. When set, it replaces `counters.clock`. |
| `buffer` | `GuardEventBufferOptions` (`{ max: number }`) | none — no buffer; `recent()` returns `[]` | Retain the last `max` decoded events in memory for `recent()` / `recentJsonLines()`. `max` must be a positive integer, otherwise `RangeError`. Non-durable: a restart empties it. |
| `includeRaw` | `boolean` | `false` | Attach the raw `rpc.Api.EventResponse` to every committed event. Memory cost per event; leave off in long-running fleets. |
| `cursorStore` | `CursorStore` | a process-local `InMemoryCursorStore` | Persists the committed-stream cursor. ⚠️ Without a durable store, a restart resumes from the head and skips events emitted while the process was down (or replays history when `startLedger` is used). |
| `failedTxCursorStore` | `CursorStore` | a separate process-local `InMemoryCursorStore` | Cursor store for the failed-transaction scan. Never falls back to `cursorStore`; sharing would replay or skip failed transactions. |

#### `GuardTelemetryLocalConfig` (local-only listener, no RPC)

| Option | Type | Default | Meaning |
| --- | --- | --- | --- |
| `counters` | `GuardTelemetryCountersOptions` | none — `stats()` returns `null` | Counters fed through `observe(event)`. |
| `clock` | `() => number` | `Date.now` | Clock for `counters.windowMs` eviction; replaces `counters.clock` when set. |
| `logger` | `GuardLoggerInput` | none — silent | Optional log sink. |

#### `GuardTelemetryCountersOptions` (`config.counters`)

Exactly one of `windowEvents` / `windowMs` is required; both, neither, or a non-positive value throws at construction.

| Option | Type | Default | Meaning |
| --- | --- | --- | --- |
| `windowEvents` | `number` (positive integer) | none | Keep the last N decisions. Deterministic: no clock is consulted. |
| `windowMs` | `number` (positive) | none | Keep decisions observed in the last `windowMs` ms, using `clock`. |
| `clock` | `() => number` | `Date.now` | Clock for `windowMs` eviction and `windowStart`. Overridden by the listener-level `clock` when that is set. |

Counters only count what this listener observed: ⚠️ `blocked: 0` is not proof that nothing was refused (check `stats().coverage`).

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
| `feeBump` | `FeeBumpConfig` | `maxAttempts: 3`, `feeMultiplier: 2`, `initialInclusionFee: 100n` | Bounded fee-increase retry on minimum-fee broadcast rejections. Every attempt is re-simulated and re-enforced by the guard. `maxAttempts` is an integer ≥ 1, `feeMultiplier` is finite and > 1, `initialInclusionFee` accepts a positive `bigint` or base-10 integer string in stroops, and optional `maxInclusionFee` (same shapes, greater than the initial fee) is a hard ceiling: a breach returns an `error` outcome carrying `FeeCapExceededError` without broadcasting the over-cap transaction. |
| `maxRetries` | `number` (integer ≥ 0) | none — each retry class keeps its own budget | Overall cap across retry classes; `0` means a single attempt. The tighter of this and a per-class budget wins. |
| `fee` | `bigint \| string` | `100` stroops (`INCLUSION_FEE`) | Inclusion fee for the envelope; set internally on fee-bump retries. |
| `signal` | `AbortSignal` | none | ⚠️ An aborted run stops at the next RPC boundary and returns the `error` outcome carrying `RpcTimeoutError`; an already-aborted signal issues no RPC. The in-flight HTTP request itself is not cancelled. |
| `timeoutMs` | `number` (≥ 0) | `DEFAULT_RPC_TIMEOUT_MS` (30 000 ms) per RPC call | ⚠️ A fired timeout is the same fail-closed `error` outcome as an abort. `0` disables the per-call timeout (a `deadlineMs` still applies). |
| `deadlineMs` | `number` (> 0) | none — only the per-call `timeoutMs` applies | ⚠️ One budget for discovery, signing, simulation, retry backoff, broadcast and polling. Expiry is fail-closed (`RpcTimeoutError` with `deadline: true`), even after the guard approved the call; a dry run reports `undetermined`. |
| `clock` | `Clock` | `systemClock` | Time source for deadline accounting and poll/backoff delays. Must have `now()` and `sleep()`. |
| `onStep` | `(step: InvokeStepEvent) => void` | none | One event per stage attempt (probe → sign → simulate → broadcast). Exceptions are isolated. |
| `onSubmitted` | `(event: SubmissionAcceptedEvent) => void` | none | Called once with the network's answer to the broadcast, before polling, so the transaction hash survives a failed poll. |
| `onQueue` | `(event: InvokeQueueEvent) => void` | none | Per-source-account queue observability: `waiting` on join, `acquired` when the call runs, with `source`, `depth`, `waitedMs`, `acquired`. Isolated like `onStep`. Counters belong to the `rpc.Server` object's queue state, so `invokeQueueStats(server)` reports only that server's accounts and `invokeQueueStats()` sums the live server contexts in this process — the queue is per server object and process, never global. |
| `logger` | `GuardLoggerInput` | none — silent | Stage attempts and retries at `debug`, a refusal at `info`, no-verdict outcomes at `warn`. Never changes behaviour. |

### Interception & Execution

- `PreFlightInterceptor`
  - `constructor(options: PreFlightInterceptorOptions)` — Every option, default and safety note: [Constructor options](#preflightinterceptoroptions-alias-of-preflightconfig). Pass `cache: { ttlMs }` or `cache: { ttlLedgers }` to opt into the short-lived cache; omit it for fresh simulations. Concurrent identical `check()` calls share one in-flight run by default; pass `coalesceInFlight: false` to disable that.
  - `check(call: ContractCall, options?: PreFlightCheckOptions): Promise<PreFlightDecision>` — Returns `admissible | blocked | undetermined` without throwing or broadcasting. `options.signal` / `options.timeoutMs` bound the RPC calls it makes; a fired bound returns the fail-closed `undetermined` verdict carrying a typed `RpcTimeoutError` — see [Bounding a check or an invoke](#bounding-a-check-or-an-invoke-signal-and-timeoutms).
  - `simulateForDiagnostics(call: ContractCall, options?: SimulationDiagnosticsOptions): Promise<SimulationDiagnostics>` — Runs the same probe and enforced simulation as `check()` but returns no verdict: `authoritative` is always `false`, and the result carries decoded guard events, resource usage and the resource fee, or the typed error. `includeRaw` opts into retaining raw event payloads. Nothing is signed for submission, broadcast or cached. See [Troubleshooting](docs/troubleshooting.md).
  - `checkBatch(calls: ContractCall[], options?: CheckBatchOptions): Promise<PreFlightBatchDecision>` — Returns one verdict per call with all-or-nothing `admissible` semantics. `options.signal` is forwarded to every call, so once it fires each remaining call is reported as `undetermined` without an RPC; `options.timeoutMs` stays per-call, while `options.deadlineMs` is one absolute budget for the whole batch; once spent, no further call starts and unfinished calls are fail-closed `undetermined` verdicts — see [`CheckBatchOptions`](#checkbatchoptions-checkbatch--assertbatchallowed).
  - `assertAllowed(call: ContractCall): Promise<PreFlightDecision & { allowed: true }>` — Evaluates a call and returns the admissible decision, or throws `GuardBlockedError` (on policy block) or `GuardUndeterminedError` (on undetermined/transport failure). Never lets a raw transport error escape.
  - `assertBatchAllowed(calls: ContractCall[], options?: CheckBatchOptions): Promise<PreFlightBatchDecision & { admissible: true }>` — Batch throw-on-refusal form. Returns the batch decision if all calls are admissible, or throws `GuardBlockedError` on the first blocked call or `GuardUndeterminedError` on an undetermined call or transport failure.
  - `invalidate(call?: ContractCall): void` — Clears all cached decisions or only entries for one call.
- `CostPreChecker`
  - `constructor(config: CostPreCheckConfig)` — Accepts `interceptor`, optional `maxFeeStroops`, and optional `policySource` (contract address or `GuardPolicy`). Full table: [`CostPreCheckConfig`](#costprecheckconfig-new-costprecheckerconfig).
  - `check(call: ContractCall, options?: CostPreCheckOptions): Promise<CostPreCheckResult>` — Returns `within_budget | over_budget | blocked | undetermined` with additive `policyContext`.
  - `checkWithCost(call: ContractCall): Promise<{ decision, cost }>` — Returns the interceptor verdict and the cost of the **same** single simulation. Prefer this over calling `check()` on both classes.
  - `invoke(options: InvokeOptions): Promise<InvokeResult>` — End-to-end pipeline: probe, sign auth, simulate, and broadcast. Accepts an optional `onStep(step: InvokeStepEvent)` hook reporting per-stage `start`/`ok`/`fail` timing events with a 0-based retry `attempt` index; callback exceptions are isolated and omitting the hook changes nothing. `options.signal` / `options.timeoutMs` stop a stalled run; `options.deadlineMs` bounds the whole action including retries and polling. Either bound is reported through `invoke`'s `error` outcome as a typed `RpcTimeoutError`. Terminal outcomes also carry additive `retry` metadata (attempt count, retryable classes, delays and exhaustion) with no payloads or XDR.
  - `checkTransaction(transaction, options?: CostTransactionCheckOptions): Promise<CostDecision>` — Prices the exact already-built envelope using its supplied simulation or the configured RPC server, checks the network passphrase, and marks provenance as `source: "transaction"`.
- `startHeartbeat(options): Promise<HeartbeatHandle>` — Drift-aware dead-man keep-alive. Fires `heartbeat()` on an interval, reports lateness (`handle.missedBeats`, `onBeat`'s `lateMs`), routes every failure to `onError`, validates `interval <= grace/3` before the first beat when the grace window is readable, and stops cleanly (`await handle.stop()`). See “Keep the dead-man switch alive”.
- `heartbeat(params): Promise<HeartbeatResult>` — Signs, submits and confirms a single `heartbeat()`: returns the transaction hash, ledger and a `status()` re-read (`lastHeartbeat`, `verified`), and throws `HeartbeatBlockedError` (`heartbeat_expired`, `admin_frozen`, …) instead of returning on a refusal. `readGuardStatus()` is the underlying `status()` read. See “Send one heartbeat”.
- `submitHeartbeat(params): Promise<HeartbeatSubmission>` — Signs and submits a single `heartbeat()` with the agent's guard authorization; the default submission `startHeartbeat` uses.
- `HeartbeatBlockedError` / `isRetryableHeartbeatFailure(error)` — The typed refusal of a blocked heartbeat, and the classifier that decides whether a failure is a transport failure (retryable) or a decision (never retried). See [Bounded retry for a transient outage](#bounded-retry-for-a-transient-outage).

#### Fee units: stroops and XLM

`CostPreChecker` reports fees as exact integer stroops — the raw value is the
source of truth, and it is what a `maxFeeStroops` ceiling is compared against.
`formatFee()` renders the same number in XLM, the unit operators think in, using
**integer math only** (XLM has 7 decimal places; float rounding on
money-adjacent output in a security tool is not acceptable) and with no trailing
zeros:

```ts
import { startHeartbeat } from "stellar-agent-guard-sdk";

const hb = await startHeartbeat({
  server,
  guard: GUARD_ID,
  signer: agentKeypair,        // Keypair or AgentSigner
  intervalMs: 30_000,
  maxSkewMs: 2_000,            // tolerated drift before a beat counts as missed
  onBeat: ({ lateMs }) => { if (lateMs > 2_000) alert("heartbeat late"); },
  onError: (error) => logger.error("heartbeat failed", error),
  graceSecs: 150,              // optional pre-read: validated as interval <= grace/3
});

// on shutdown: request cancellation, wait up to 5s for the in-flight beat
const stop = await hb.stop({ timeoutMs: 5_000 });
if (!stop.settled) logger.warn(`heartbeat stop ${stop.reason}`);
```

- The first beat fires immediately, then every `intervalMs` on a fixed cadence — a slow beat surfaces as lateness on the next one instead of pushing the whole schedule. A submission that outlives several slots skips the stale ones instead of firing a catch-up burst.
- A beat later than `maxSkewMs` increments `hb.missedBeats` and is reported as `lateMs` in `onBeat`; each cadence slot skipped while a submission was in flight is counted too. Alert on lateness, not only on failure. `hb.lastBeatAt` is the epoch ms of the last successful beat.
- Every submission rejection goes to `onError`; nothing escapes as an unhandled rejection.
- `stop()` (or the `signal`) tears down cleanly: no beat is sent after it, and by default it resolves once an in-flight beat has settled. `stop()` first aborts the submission context's `signal`; pass `stop({ timeoutMs })` or set `stopTimeoutMs` when a custom transport might not settle, and inspect `{ reason, settled }` on the result.
- When the grace window is readable (`graceSecs`, or a `readPolicy` read), an interval longer than `grace / 3` throws `HeartbeatIntervalError` **before** the first beat; an unreadable policy warns via `onWarning` and starts anyway.
- A beat that would fall in the same wall-clock second as the previous accepted one is skipped client-side; the contract deduplicates independently.
- Every input is validated **before** the scheduler starts: a negative or non-finite `maxSkewMs`, a negative or non-finite `stopTimeoutMs`, a grace window that is not a non-negative safe integer or bigint, a callback that is not callable, or an unusable retry budget is rejected with an error naming the field — before the first beat, and before the grace window is even read from the chain.

#### Bounded retry for a transient outage

A failed heartbeat used to wait for the next fixed interval, so an RPC outage that landed near the grace boundary could freeze the account even after connectivity returned. `retry` adds a bounded, jittered recovery:

```ts
const hb = await startHeartbeat({
  server,
  guard: GUARD_ID,
  signer: agentKeypair,
  intervalMs: 30_000,
  retry: { maxAttempts: 3 },   // opt-in — the default is one attempt per beat
  onWarning: (message) => logger.warn(message),
  onError: (error) => logger.error("heartbeat failed", error),
});
```

- Only a **transport** failure is retried (a `BroadcastError`, an `RpcTimeoutError`, a `SimulationError`). A **policy block is never retried**: the guard made a decision, and hammering a call it has already refused only adds load. An error the SDK cannot classify is reported, not retried.
- The delay before the next attempt is a full-jitter sample of a bounded window, so agents that hit the same outage do not retry in a synchronized herd.
- The attempt that failed and the delay before the next one are announced through `onWarning`; the failure that ends the beat is reported once through `onError`, with the original error. A successful beat reports how many attempts it took in `onBeat`'s `attempt`.

#### Stopping with an in-flight submission

A custom `submit(beat, { signal })` receives an `AbortSignal` that `stop()` aborts before waiting. The default is still graceful: `stop()` waits for the submission promise to settle, so a transport that honours the signal shuts down promptly. If the transport may never settle, bound the wait with `stop({ timeoutMs })` (or `stopTimeoutMs` on `startHeartbeat`); a fired bound returns `{ reason: "timeout", settled: false }`, while a graceful settle returns the in-flight submission's value or terminal error. No deadline is applied unless you ask for one.

The combined heartbeat-loop + pre-flight pattern is tracked as an integration guide in [#74](https://github.com/Stellar-Agent-Guard/stellar-agent-guard-sdk/issues/74).

## API Reference

The complete SDK API reference lives in [`docs/api-reference.md`](docs/api-reference.md) — method signatures, options, return shapes and examples for `PreFlightInterceptor`, `CostPreChecker`, `GuardTelemetryListener`, `validateGuardPolicy`, the framework adapters and the `invoke()` pipeline. The README keeps this stub so the npm landing page stays readable; the reference itself grows alongside the other `docs/` guides.

Prefer this over calling `interceptor.check(call)` and `costChecker.check(call)`
in sequence. That two-call pattern still works and its types are unchanged, but
it carries the fee-drift caveat above. `precheckCostWithDecision()` is the
one-shot form.

### Telemetry & Helpers

- [`docs/event-schema.md`](docs/event-schema.md) — every telemetry event and field, each labelled with its stability tier: **Stable** (relied on), **Append-only** (new values may appear, existing ones will not be removed or renamed), **Best-effort** (may change in any release), **Internal** (implementation detail, not a contract).
- `GuardTelemetryListener`
  - `constructor(config?: GuardTelemetryInputConfig | GuardTelemetryLocalConfig)` — Full table: [`GuardTelemetryConfig`](#guardtelemetryconfig-new-guardtelemetrylistenerconfig).
  - `watch(params?: GuardTelemetryWatchParams): AsyncIterable<GuardEventPage>` — Tails on-chain and uncommitted events. `params.signal` aborts at loop boundaries: no RPC call before the first pull, no poll after an abort, and the delay between polls is cut short. A request already in flight cannot be cancelled — see [Aborting a watch](#aborting-a-watch-what-cancellation-does-and-does-not-cover). `params.maxBufferedPages?: number` bounds the look-ahead in front of the consumer (default `DEFAULT_MAX_BUFFERED_PAGES` = 2, `0` = strict consumer pacing); cursors are saved at delivery, so the stored cursor never leads the consumer (issue #36).
  - `watchAll(params?: GuardTelemetryUnifiedParams): AsyncIterable<GuardEvent>` — Merges the committed ledger stream with the `diagnostics` batches you feed it into **one ordered, de-duplicated stream**, so a single loop sees blocked decisions too. Each event carries `stream: 'committed' | 'diagnostic'` and, for diagnostics, `observedAt`. Ordering and de-duplication rules: [`docs/event-schema.md`](docs/event-schema.md).
  - `health(): GuardTelemetryHealthSnapshot` — Read-only operational snapshot: stream state (`idle`/`running`/`recovering`/`stopped`/`aborted`/`failed`), last successful poll, consecutive failures, per-stream cursors, failed-tx degradation, and known coverage gaps. Every field is a copy. Contract: [`docs/api/telemetry-listener.md`](docs/api/telemetry-listener.md#health-guardtelemetryhealthsnapshot).
  - `serializeEvent(event: GuardEvent): string` — Canonical single-line JSON for deterministic JSON-lines log shipping. Fixed key order, drops `undefined`, keeps `null`, renders `bigint` as a decimal string. Contract: [`docs/event-schema.md`](docs/event-schema.md#canonical-json-serialization--serializeevent).
- `validateGuardPolicy(policy: unknown, options?: ValidatePolicyOptions | string): PolicyFailure[]` — Validates policy configuration against SPEC §8 rules prior to broadcast, accumulating all failures for complete form UX.
- `POLICY_RULE_IDS` — Canonical array of SPEC §8 validation rule identifiers.
- `policyToScVal(policy: PolicyConfig): xdr.ScVal` — Encodes a policy as the contract's canonical sorted ScVal struct.
- `decodePolicy(scVal: xdr.ScVal): PolicyConfig` — Strictly decodes `policy()`/set-policy ScVal data, including Option/Vec and numeric normalization.
- `policyFromScVal(scVal)` — Alias for callers using the issue's original function name.
- `describePolicy(policy: PolicyConfig | null, options?: DescribePolicyOptions): string` — A compact, log-friendly rendering of the policy in force, including the recipient caps, the blocklist and the active window with its state. Recipient lists are reported as counts unless `detail: true` asks for the addresses.
- `invoke(options)` / `invoke({ ...options, dryRun: true })` — Broadcasts an admissible result, or returns the full pre-broadcast dry-run trace.
- `verifyAgentSignature(publicKey, payload, signature): boolean` — Verify-only Ed25519 check against a strkey or raw 32-byte key.
- `GuardError`, `SimulationError`, `SigningError`, `BroadcastError`, `PolicyDecodeError`, and `ContractResponseError` — Typed failure hierarchy.
- `decodeCheckResult(raw): CheckResult` — Decodes `Allowed` or `Blocked(reason)`.
- `decodeAuthDecision(event: SorobanRpc.Api.GetEventsResponse.Event): AuthDecisionEvent | null`
- `decodeGuardEventXdr(xdrBase64: string, source?: 'ledger' | 'diagnostic'): GuardAuthDecision | null` — Offline decode of a raw base64 event XDR. Accepts either a `DiagnosticEvent` (what `getEvents()` and a simulation error carry) or a `ContractEvent` (what a block explorer exposes) and returns the same decision the object-path decode produces. Malformed base64, an XDR that is not a contract event, and an event that is not an `event_auth_checked` decision all return `null` — it never throws, so fixture checks and operator copy-paste cannot crash a long-running process.
- `guardEventsFromDiagnostics(events: xdr.DiagnosticEvent[]): GuardEvent[]` — Each decoded `GuardEvent` carries a stable `id`: `ledger:<txHash>:<topic>` for committed events, `diag:<sha256>` for blocked ones (which are rolled back and have no hash to anchor on). Same event re-parsed → same id; two different blocks in one simulation → different ids. Format and collision notes: [`docs/event-schema.md`](docs/event-schema.md).
- `GuardLogger`, `GuardLoggerInput`, `GuardLogMeta`, `GUARD_LOG_LEVELS` — the optional, structurally-typed log sink shared by every config above; `SILENT_LOGGER` is what a config resolves to when none is supplied. See [Optional logging](#optional-logging-the-sdk-is-silent-unless-you-ask).
- `explainReason(reason: string | number, locale?, overrides?): string` — Human-readable explanation of contract reason codes. The default call is unchanged; the optional `locale` catalog and per-reason `overrides` localise or reword a refusal without an i18n dependency. Reason keys, titles and remediation text: [`reasonMessages` / `reasonMessagesEn`](#reason-messages-issue-96).
- `isDeadManFrozen(status: GuardStatus): boolean`
- `deadManRemaining(status: GuardStatus, policy: PolicyConfig | null): bigint | null`
- `dmsUrgency(status: GuardStatus, policy: PolicyConfig | null, nowSecs?: bigint, warnRatio = DMS_WARN_RATIO_DEFAULT): 'ok' | 'warn' | 'expired' | 'unknown'` — Dead-man countdown urgency for dashboards: `warn` from `warnRatio` (default `DMS_WARN_RATIO_DEFAULT` = 0.8) of the grace period, `expired` once the grace has elapsed. `unknown` exactly where `deadManRemaining` is `null` (no policy, switch disabled, never heartbeated — never ≠ expired).
- `policyDiff(a: PolicyConfig, b: PolicyConfig): PolicyChange[]` — Structured change list between two policies for operator display (e.g. when the policy revision bumps; dashboard change-history feed: stellar-agent-guard-dashboard#17). Lists compare as sets, so a pure reorder is no change; protocols match by contract and report `fns` changes at paths like `protocols[0].fns[1]`.

#### Dashboard-style snapshot (issue #68)

A consumer that wants "the last N decisions, right now" — a dashboard panel, an agent status endpoint — can opt into a bounded in-memory window instead of maintaining its own store:

```ts
import { GuardTelemetryListener } from "stellar-agent-guard-sdk";

const listener = new GuardTelemetryListener({
  server,
  guard: GUARD_ID,
  buffer: { max: 200 }, // opt-in; omitted → no buffer is allocated
});

// ...drive it with listener.watch() or listener.watchAll(), then read on demand:
const lastBlocked = listener.recent({ stream: "diagnostic" });
const capRefusals = listener.recent({ reason: "per_tx_cap_exceeded" });
const recentWindow = listener.recent({ fromLedger: 4_700_000 });
```

`recent(filter?)` returns the retained events oldest-first, filtered by any of `stream`, `reason`, `fromLedger`, `toLedger`. The buffer is FIFO and non-durable: it holds only what this listener decoded in this process, and a restart empties it. Persistence across restarts is a cursor store (tracked separately), not something this buffer pretends to provide.

What it returns is a **detached snapshot**: the array, the events in it, their decoded `data`/`decision` and the opt-in `raw` payload are all copies, so editing a returned event cannot change what the listener still retains. A listener with no `buffer` configured copies nothing — `recent()` returns `[]`.

`recentJsonLines(filter?)` returns the same bounded window as **JSON Lines** (issue #324) — one `serializeEventRecord()` line per event, oldest first, `filter` applied identically. It returns a string and never touches the filesystem; `bigint` values are decimal strings and byte arrays are `bytes:<hex>`, so the export parses without the SDK. The opt-in `raw` payload is never included: the projection is a fixed field list, so an incident bundle cannot leak a retained debug payload.

#### Raw events for bug reports (issue #94)

When a decoded verdict looks wrong, attach the **undecoded source event** to the SDK bug report. Decoding discards it by default — the raw payload carries XDR `ScVal`s and host-shaped objects, and retaining one per event is a memory decision — so it is opt-in:

```ts
// Committed feed: opt in on the listener.
const listener = new GuardTelemetryListener({ server, guard: GUARD_ID, includeRaw: true });

// Diagnostic feed: opt in at the decode site.
const events = guardEventsFromDiagnostics(diagnosticEvents, GUARD_ID, { includeRaw: true });

// Every event then carries `raw`: the `rpc.Api.EventResponse` for a committed
// event, or the host-shaped diagnostic object for a blocked one.
const event = (await listener.poll({ startLedger })).events[0];
console.error(JSON.stringify(event.raw, (_key, value) =>
  typeof value === "bigint" ? value.toString() : value));
```

When `includeRaw` is not set, `raw` is **absent** (undefined) — nothing is retained. Leave it off in a long-running fleet; turn it on for the debugging session or the bug-report window. The `id` field stays stable either way, so a raw event can be correlated with the decoded event it produced.

#### Reason messages (issue #96)

`reasonMessages` exposes each reason's numeric code and its stable title/body/remediation keys, and `reasonMessagesEn` holds the built-in English text — so a dashboard can render a table, and a consumer can key its own translations, without the SDK taking an i18n dependency:

```ts
import { reasonMessages, reasonMessagesEn, explainReason } from "stellar-agent-guard-sdk";

for (const [reason, { code, titleKey, remediationKey }] of Object.entries(reasonMessages)) {
  console.log(code, reasonMessagesEn[reason as keyof typeof reasonMessagesEn].title, remediationKey);
}

// Localise one reason; a missing key falls back to English.
explainReason("per_tx_cap_exceeded", {
  [reasonMessages.per_tx_cap_exceeded.bodyKey]: "Le montant dépasse le plafond par transaction.",
});

// Or override individual reasons outright.
explainReason("paused", undefined, { paused: "Agent paused by the operator." });
```

#### Ship events to your logger

`serializeEvent(event)` gives you one canonical JSON line per event, so a log pipeline gets a stable, diffable record with no logger dependency in the SDK:

```ts
import { serializeEvent } from "stellar-agent-guard-sdk";

for await (const event of listener.watchAll({ diagnostics })) {
  logger.info(serializeEvent(event)); // one deterministic JSON line per event
}
```

Key order, the drop-`undefined`/keep-`null` policy, and the `bigint`-to-decimal-string normalization are documented in [`docs/event-schema.md`](docs/event-schema.md#canonical-json-serialization--serializeevent).

## Architecture

Stellar Agent Guard operates across three dedicated repositories:

```
┌─────────────────────────────────────────────────────────────────────────┐
│                      Operator (Browser / Freighter)                     │
│                                     │                                   │
│                                     ▼                                   │
│              stellar-agent-guard-dashboard (Next.js / UI)               │
└─────────────────────────────────────┬───────────────────────────────────┘
                                      │
                                      ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                   AI Agent Runtime (LangChain / ElizaOS)                │
│                                     │                                   │
│                                     ▼                                   │
│                stellar-agent-guard-sdk (TypeScript / RPC)               │
│               • Pre-flight policy check  • Cost pre-checks              │
│               • Agent-auth tx signing    • Event telemetry              │
└─────────────────────────────────────┬───────────────────────────────────┘
                                      │
                                      ▼ Soroban RPC
┌─────────────────────────────────────────────────────────────────────────┐
│               stellar-agent-guard-contracts (Soroban / Rust)             │
│            • CustomAccount interface (`__check_auth`)                   │
│            • Spend caps, rolling window, allowlists, dead-man switch    │
└─────────────────────────────────────────────────────────────────────────┘
```

| Repository | Role | Documentation |
|---|---|---|
| [**stellar-agent-guard-contracts**](https://github.com/aigbagbobila/stellar-agent-guard-contracts) | Soroban smart contracts implementing Custom Account Abstraction and spending policy firewall | [GitBook Docs](https://soroban-cost-estimator.gitbook.io/stellar-agent-guard-contracts/) |
| [**stellar-agent-guard-sdk**](https://github.com/aigbagbobila/stellar-agent-guard-sdk) (this repo) | TypeScript SDK for pre-flight interception, simulation pricing, and AI agent framework integration | [GitHub](https://github.com/aigbagbobila/stellar-agent-guard-sdk) |
| [**stellar-agent-guard-dashboard**](https://github.com/aigbagbobila/stellar-agent-guard-dashboard) | Client-side operator dashboard for policy deployment, inspection, and emergency panic-button freeze | [GitHub](https://github.com/aigbagbobila/stellar-agent-guard-dashboard) |

## ✅ Verified against live testnet

Proven against a real deployed instance on Stellar testnet (protocol 28, `Test SDF Network ; September 2015`):

- **Guard (custom account)**: `CAPADGEK457RHKN4RYVUMDJTFHDSG7R5HREQONKLYK7MFKC5WFENPP44`
- **SAC Token**: `CDCYDGBGS5AZ5BZS6XY2SK2PHJHSOEGTN3N4INCK34KF6GU2BGC7Z6MB`
- **WASM bytecode hash**: `f47919f92e78fdd034836aa61955fc338dd56a218c448c37df1867a8c3da0f63` (identical to Phase 1 artifact)

Verify a downloaded artifact against the pinned hash before deploying — the same constant the dashboard checks, so there is one source of truth rather than a copy per consumer:

```ts
import { readFileSync } from "node:fs";
import { verifyGuardWasm } from "stellar-agent-guard-sdk";

const result = await verifyGuardWasm(readFileSync("guard.wasm"));
if (!result.ok) {
  throw new Error(`WASM mismatch: got ${result.actual}, expected ${result.expected}`);
}
```

`verifyGuardWasm` hashes with WebCrypto (`crypto.subtle`), so the identical call runs in Node and in the browser and needs no extra dependency. It is async, because `crypto.subtle.digest` is. `GUARD_WASM_HASH` is exported if you need the constant on its own.

### 5/5 Live Enforcement Scenarios

| Scenario | Condition | Result | Evidence |
|---|---|---|---|
| 1. Within caps | Transfer 100 within caps (cap: 1000, window: 150) | **Allowed** | Tx hash `f8f5b3c51b85c8777c956d71330d015fcf72fa57548077d8b32969f8ba9c762e` at ledger `4704849` |
| 2. Per-tx cap | Transfer 1001 > 1000 cap | **Blocked** (`per_tx_cap_exceeded`) | Diagnostic event `event_auth_checked, blocked, per_tx_cap_exceeded`, pre-broadcast, 0 fees |
| 3. Rolling window | Transfer 76 + 76 = 152 > 150 window cap | **Blocked** (`window_cap_exceeded`) | Rolling window accumulation refusal, balances untouched |
| 4. Recipient allowlist | Transfer to unlisted recipient | **Blocked** (`recipient_not_allowed`) | Default-deny address check refusal |
| 5. Account paused | Call while `paused = true` | **Blocked** (`paused`) | Account-state refusal cleanly distinguished from policy caps |

Complete run output and assertion logs are preserved in [`tests/fixtures/integration-evidence.md`](tests/fixtures/integration-evidence.md).

## Honest limitations

- **Enforcement boundary for arbitrary calls**: Full amount/recipient limits are native to SAC token transfers. Arbitrary Soroban contract calls are enforced via protocol/function allowlists, active window, pause, and dead-man switches; per-call amount limits are not available generically from host auth contexts (tracked as v2).
- **Single-key agent signing today, multi-key prepared**: A guard account registers one Ed25519 agent key, and `buildGuardAuthEntry` signs the authorization digest with it. The signing path is now a seam (`AgentSigner`: sign a 32-byte digest, return signature bytes) and every public config accepts either an `AgentSigner` or a plain `Keypair` — so the current single-key behaviour is unchanged, and threshold/multi-key agent signing lands behind the same interface when the contracts repo's v2 decision does. Research, the recommended wire shape, and the revisit trigger: [`docs/concepts/multi-key-agent-signing.md`](docs/concepts/multi-key-agent-signing.md).
- **AutoGPT integration**: AutoGPT lacks an extensible pre-execution interceptor hook at the surveyed revision; findings and future integration paths are documented in [`docs/integration-hooks.md`](docs/integration-hooks.md).
- **Testnet signing credentials**: Running `npm run test:integration` requires `.env.phase2` populated with funded testnet keypairs. The live suite is **not run on every PR**; which PRs must run it, and the exact enforcement-path file list, are defined once in [`CONTRIBUTING.md` § Which tests does my PR need?](CONTRIBUTING.md#which-tests-does-my-pr-need-canonical-matrix). It also runs on a weekly schedule ([`.github/workflows/live-suite.yml`](.github/workflows/live-suite.yml)) to catch host/testnet drift, with the committed evidence in [`tests/fixtures/integration-evidence.md`](tests/fixtures/integration-evidence.md). A green `ci` therefore means the required checks ran — not that the live suite ran against this change.
- **Pre-flight is a prediction, not a settlement guarantee**: the four known pre-flight fidelity limits (moving window state, a moving fee market, simulation not executing, approximated batch semantics) and the cache-staleness caveat are enumerated with their mitigations, residual risks, and code/test citations in the [simulation-fidelity decision table](docs/api/interceptor.md#simulation-fidelity-decision-table) linked from [Fidelity & limits](#fidelity--limits).
- **Integration failures**: use the [error catalog](docs/errors.md#error-classes) to identify an exported class, then the [troubleshooting playbook](docs/troubleshooting.md) to map common errors and outcomes to causes and supported fixes.

## Enforcement scope — read this before relying on the caps

Full recipient/amount enforcement — spend caps, allowlists, per-transaction limits — is native and automatic for SAC token transfers (`transfer`/`transfer_from`), since these are the calls whose arguments the Soroban auth context exposes for inspection. For other Soroban contract calls made by the guarded account (arbitrary DEX/lending/protocol calls), the policy engine still enforces window and pause state, but per-call amount/recipient limits are not yet enforced — extending fine-grained enforcement to arbitrary calls is tracked as a v2 item, not implied as already covered.

This boundary is an inherent property of the platform (the auth context does not expose arbitrary call arguments generically), not a gap this project hides or overclaims. The classification that produces this boundary (`AssetTransfer` vs `Protocol` vs `Unknown` default-deny) is spelled out in SPEC §6.

## Topics

`stellar`, `soroban`, `ai-agents`, `guardrails`, `custom-account`, `pre-flight`,
`spend-limits`, `cost-estimation`, `langchain`, `elizaos`, `mcp`, `telemetry`, `typescript`

## Maintainers

| Name | GitHub | Telegram |
|---|---|---|
| Hybrid | [@aigbagbobila](https://github.com/aigbagbobila) | [@aigbagbobila](https://t.me/+EzSusj-2vVhhNmI0) |

## Socials

- [Telegram](https://t.me/+EzSusj-2vVhhNmI0)
- [Discord](https://discord.gg/Z766vsgjg)

## Contact

- GitHub issues: <https://github.com/aigbagbobila/stellar-agent-guard-sdk/issues>
- Maintainer (GitHub): [@aigbagbobila](https://github.com/aigbagbobila)
- Funding: This project has no funding channel — that's deliberate.
- Security disclosures: see the local [SECURITY.md](SECURITY.md) for SDK issues; contract/protocol issues and deployed-instance incidents go to the contracts repo's [SECURITY.md](https://github.com/aigbagbobila/stellar-agent-guard-contracts/blob/main/SECURITY.md)
- Security review: [`docs/attack-surface.md`](docs/attack-surface.md) maps where untrusted data enters and leaves the SDK, and [`docs/threat-model.md`](docs/threat-model.md) states what can go wrong

## License

Licensed under [MIT](LICENSE). This is unaudited security tooling that gates real fund access — see the contracts repo's [SECURITY.md](https://github.com/aigbagbobila/stellar-agent-guard-contracts/blob/main/SECURITY.md) before considering mainnet use.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for details on coding standards, PR process, and
project structure — including the strict one-commit-per-logical-unit rule and the
[TypeScript strictness ratchet](CONTRIBUTING.md#typescript-strictness-ratchet)
(`npm run check:strict-ratchet`).

Before changing the public surface, the dependency set, or the runtime the SDK runs
in, read [`docs/design-principles.md`](docs/design-principles.md): fail-closed
verdicts, no secret handling, one runtime dependency, additive-only 0.x surface,
a browser-safe core, and logger-optional silence. Departures are maintainer
decisions (`tier:maintainer-decision`), not silent exceptions.

Looking for something to work on? The
[issue backlog](https://github.com/aigbagbobila/stellar-agent-guard-sdk/issues)
holds scoped issues with Summary / Acceptance Criteria / Tech Stack — good first tasks for
the Drips Stellar Wave contributor sprints.

![Contributors](https://contrib.rocks/image?repo=aigbagbobila/stellar-agent-guard-sdk)
