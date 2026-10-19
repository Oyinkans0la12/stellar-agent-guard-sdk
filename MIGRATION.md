# Migration Guide: Branded Address Types (v0.2.0)

## Overview

Version 0.2.0 introduces **branded types** for Stellar addresses to catch type mismatches at compile time. These prevent accidentally passing account addresses (G...) where contract addresses (C...) are required, and vice versa.

## Breaking Changes

The following function signatures now use branded types:

- `PreFlightConfig.guard`: changed from `string` to `ContractAddress`
- `ContractCall.contract`: changed from `string` to `ContractAddress`
- `buildSetPolicyCall(guard, policy)`: `guard` parameter is now `ContractAddress`
- `buildFreezeCall(guard)`: `guard` parameter is now `ContractAddress`
- `buildUnfreezeCall(guard)`: `guard` parameter is now `ContractAddress`
- `buildRotateAgentKeyCall(guard, newAgent)`: `guard` parameter is now `ContractAddress`
- `PolicyConfig.assets`: changed from `string[]` to `ContractAddress[]`
- `PolicyConfig.recipients`: changed from `string[]` to `AccountAddress[]`
- `PolicyConfig.blocked_recipients`: changed from `string[]` to `AccountAddress[]`
- `ProtocolRule.contract`: changed from `string` to `ContractAddress`
- `RecipientWindowCap.recipient`: changed from `string` to `AccountAddress`

## How to Migrate

### Option 1: Use Type Guards for Runtime Validation (Recommended)

If your addresses come from user input, API responses, or environment variables, validate them with the new type guards:

```typescript
import {
  isContractAddress,
  isAccountAddress,
  PreFlightInterceptor,
  isContractAddress,
} from "stellar-agent-guard-sdk";

// Validate a contract address from environment or API
const guardAddress = process.env.GUARD_ADDRESS;
if (!isContractAddress(guardAddress)) {
  throw new Error(`Invalid guard contract address: ${guardAddress}`);
}

const recipientAddress = await fetchRecipientFromAPI();
if (!isAccountAddress(recipientAddress)) {
  throw new Error(`Invalid recipient account address: ${recipientAddress}`);
}

// Now TypeScript knows these are the correct types
const interceptor = new PreFlightInterceptor({
  guard: guardAddress, // Type-safe: ContractAddress
  // ...
});

const policy: PolicyConfig = {
  assets: [guardAddress], // Error! guardAddress is ContractAddress, not allowed here
  recipients: [recipientAddress], // OK: AccountAddress
  // ...
};
```

### Option 2: Type Assertion for Hardcoded Known Values

If you have hardcoded, verified addresses (e.g., from your deployment notes), you can use type assertions:

```typescript
import type { ContractAddress, AccountAddress } from "stellar-agent-guard-sdk";

const GUARD = "CAPADGEK457RHKN4RYVUMDJTFHDSG7R5HREQONKLYK7MFKC5WFENPP44" as ContractAddress;
const RECIPIENT = "GBRPYHIL2CI3WHZDTOOQFC6EB4CGQOFN4L7MRJE47JREUMB5QFO6YL2" as AccountAddress;

// No runtime validation, but you've vouched for correctness
const policy: PolicyConfig = {
  recipients: [RECIPIENT],
  // ...
};
```

### Option 3: Bulk Casting for Migration

To quickly migrate an existing codebase before adding proper validation:

```typescript
import type { ContractAddress, AccountAddress } from "stellar-agent-guard-sdk";

// Convert arrays of strings to typed addresses
const guardAddresses: ContractAddress[] = (
  process.env.GUARD_ADDRESSES?.split(",") ?? []
) as ContractAddress[];

const recipients: AccountAddress[] = (
  process.env.RECIPIENTS?.split(",") ?? []
) as AccountAddress[];
```

**⚠️ WARNING**: This bypasses type safety. Use only as a temporary stepping stone; add proper validation (Option 1) as soon as possible.

## New Type Guards

The SDK now exports four type guard functions:

### `isContractAddress(value): value is ContractAddress`

Validates that a value is a valid Stellar contract address (C...).

```typescript
import { isContractAddress } from "stellar-agent-guard-sdk";

if (isContractAddress(guardId)) {
  // guardId is now typed as ContractAddress
} else {
  console.error("Invalid contract address");
}
```

Checks:
- Prefix: must start with `C`
- Length: exactly 56 characters
- Format: valid base32 encoding + StrKey checksum

### `isAccountAddress(value): value is AccountAddress`

Validates that a value is a valid Stellar account address (G...).

```typescript
import { isAccountAddress } from "stellar-agent-guard-sdk";

if (isAccountAddress(recipient)) {
  // recipient is now typed as AccountAddress
} else {
  console.error("Invalid account address");
}
```

Checks:
- Prefix: must start with `G`
- Length: exactly 56 characters
- Format: valid base32 encoding + StrKey checksum

### `isStrKeyAddress(value): value is StrKeyAddress`

Validates that a value is any valid Stellar StrKey address (either G... or C...).

```typescript
import { isStrKeyAddress } from "stellar-agent-guard-sdk";

if (isStrKeyAddress(maybeAddress)) {
  // Could be either ContractAddress or AccountAddress
  // Use isContractAddress() or isAccountAddress() to narrow further
}
```

### `isPublicKeyHex(value): value is PublicKeyHex`

Validates that a value is a valid raw public key in hex format (64 hex characters).

```typescript
import { isPublicKeyHex } from "stellar-agent-guard-sdk";

if (isPublicKeyHex(agentKey)) {
  // agentKey is a valid 64-character hex string
  // suitable for agent key rotation
}
```

## Error Prevention Examples

### Before (Compiles, Fails at Runtime)

```typescript
const policy: PolicyConfig = {
  assets: [
    "GBRPYHIL2CI3WHZDTOOQFC6EB4CGQOFN4L7MRJE47JREUMB5QFO6YL2", // ❌ Wrong! Account address in assets
  ],
  recipients: [
    "CAPADGEK457RHKN4RYVUMDJTFHDSG7R5HREQONKLYK7MFKC5WFENPP44", // ❌ Wrong! Contract address in recipients
  ],
};

// The policy validates successfully, but fails on-chain
// when you try to call set_policy
```

### After (Fails at Compile Time)

```typescript
import { isContractAddress, isAccountAddress, type ContractAddress, type AccountAddress } from "stellar-agent-guard-sdk";

// Proper validation at runtime
let assetAddr: string = "GBRPYHIL2CI3WHZDTOOQFC6EB4CGQOFN4L7MRJE47JREUMB5QFO6YL2";
if (!isContractAddress(assetAddr)) {
  throw new Error("Asset must be a contract address");
}

let recipientAddr: string = "CAPADGEK457RHKN4RYVUMDJTFHDSG7R5HREQONKLYK7MFKC5WFENPP44";
if (!isAccountAddress(recipientAddr)) {
  throw new Error("Recipient must be an account address");
}

const policy: PolicyConfig = {
  assets: [assetAddr], // ✅ Now typed as ContractAddress, safe
  recipients: [recipientAddr], // ✅ Now typed as AccountAddress, safe
};
```

## Testing Impact

Existing tests continue to work with minimal changes. If your tests hardcode addresses, use type assertions:

```typescript
import type { ContractAddress, AccountAddress } from "stellar-agent-guard-sdk";

const GUARD = "CAPADGEK457RHKN4RYVUMDJTFHDSG7R5HREQONKLYK7MFKC5WFENPP44" as ContractAddress;
const RECIPIENT = "GBRPYHIL2CI3WHZDTOOQFC6EB4CGQOFN4L7MRJE47JREUMB5QFO6YL2" as AccountAddress;

describe("policy", () => {
  it("should validate policy with typed addresses", () => {
    const policy = {
      recipients: [RECIPIENT],
      assets: [GUARD],
    };
    // ...
  });
});
```

## FAQ

**Q: Do branded types have runtime overhead?**  
A: No. Branded types are a TypeScript compile-time feature only. At runtime, they are plain strings. The type guards are simple prefix/length checks plus StrKey validation — same checks you should have been doing before.

**Q: Can I still use `as` to bypass the types?**  
A: Yes, but don't. Type assertions (`as ContractAddress`) silence the compiler without validation. Use type guards instead to keep both type safety and runtime correctness.

**Q: What if my address comes from an untrusted source?**  
A: Always use type guards (`isContractAddress`, `isAccountAddress`). Never use assertions for untrusted data.

**Q: Do I need to update my existing policy JSON files?**  
A: No. Policy structure hasn't changed. Only the TypeScript types have been updated. Your data can be loaded as before and validated with type guards before passing to SDK functions.

## Rollback

If you need to temporarily revert to untyped strings while updating your code, the old string-based signatures are available if you cast to `any`:

```typescript
const interceptor = new PreFlightInterceptor({
  guard: "CAPADGEK..." as any, // Circumvent types, not recommended
});
```

However, this negates the safety benefit. We recommend fixing your code to use type guards properly instead.

## Telemetry records: explicit versioning (issues #322, #323)

### `serializeEventRecord()` and `parseEventRecord()`

`serializeEvent()` is unchanged: it remains the Stable, unversioned (v0) JSON
format it has always been, so no existing log consumer breaks. Persisted
telemetry can opt in to an envelope instead:

```ts
// Before — bare v0 line, still supported
const line = serializeEvent(event);

// After — explicit envelope, recommended for stored records
const line = serializeEventRecord(event);
// {"v":1,"event":{"id":"ledger:…","kind":"auth_checked",…}}
```

Reading both generations is one call:

```ts
const { version, event } = parseEventRecord(line);
// version: 0 for legacy bare lines, 1 for the current envelope
```

No rewrite of stored data is required: legacy lines are identified by the
absence of `v` and still parse. A line with a `v` greater than
`TELEMETRY_EVENT_RECORD_VERSION` is reported as-is so the reader can detect a
record written by a newer SDK. See [`docs/event-schema.md`](./docs/event-schema.md)
for the full policy and the golden fixture.

### `poll()` now validates emitting contract identity

`GuardTelemetryListener.poll()` re-checks the emitting `contractId` before
decoding, rather than trusting the RPC's contract filter. Events from another
contract, and events whose identity is missing or malformed, are dropped and
counted in the new `PollResult.dropped` object. If a custom RPC omits
`contractId` for committed events, those events will now be dropped (fail
closed); use an RPC that reports it, or consume the diagnostic streams that
already attribute events to the configured guard.
