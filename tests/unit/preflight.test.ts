/**
 * Unit tests for PreFlightInterceptor:
 *  - Input validation and the throw-vs-verdict contract
 *  - Opt-in pre-flight simulation cache
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Account, Address, Keypair, nativeToScVal, rpc, xdr } from "@stellar/stellar-sdk";
import {
  DEFAULT_MAX_CONCURRENT_SIMULATIONS,
  InvalidInputError,
  PreFlightInterceptor,
  PreFlightUndeterminedError,
  preflight,
  preflightBatch,
  validateContractCall,
  type PreFlightCacheOptions,
  type PreFlightDecision,
  type PreFlightVerdictEvent,
} from "../../src/preflight.ts";
import { RpcTimeoutError } from "../../src/invoke.ts";
import {
  ContractResponseError,
  GuardError,
  GuardUndeterminedError,
  RateLimitedError,
} from "../../src/errors.ts";
import { GuardBlockedError } from "../../src/reasons.ts";
import type { PolicyConfig } from "../../src/policy.ts";
import type { ContractCall } from "../../src/tx.ts";
import { unsafeContractAddress, unsafeAccountAddress } from "../../src/policy.ts";
import { type Clock, FakeClock } from "../../src/clock.ts";
import { mulberry32, randomUint } from "./seeded-random.ts";

const VALID_GUARD = unsafeContractAddress(
  "CAPADGEK457RHKN4RYVUMDJTFHDSG7R5HREQONKLYK7MFKC5WFENPP44",
);
const VALID_TOKEN = unsafeContractAddress(
  "CDCYDGBGS5AZ5BZS6XY2SK2PHJHSOEGTN3N4INCK34KF6GU2BGC7Z6MB",
);
const RECIPIENT = unsafeAccountAddress("GAOBCRXTCO4ZCBNHALJUMJJ5JDXNOUZ7U6VZJX4UBTXAHQEO66IPU6PH");

function validTransferCall(amount: bigint = 100n): ContractCall {
  return {
    contract: VALID_TOKEN,
    fn: "transfer",
    args: [
      new Address(VALID_GUARD).toScVal(),
      new Address(RECIPIENT).toScVal(),
      nativeToScVal(amount, { type: "i128" }),
    ],
  };
}

/** Mock RPC server to track calls and assert zero requests when validation fails. */
function createMockServer(options?: {
  simulateResponse?: unknown;
  enforcedSimulateResponse?: unknown;
  simulateDelayMs?: number;
  simulateSignal?: AbortSignal;
}) {
  let requestCount = 0;
  let simulateCount = 0;
  const mock = {
    get requestCount() {
      return requestCount;
    },
    async getAccount() {
      requestCount++;
      return {
        sequenceNumber: () => "100",
      };
    },
    async getLatestLedger() {
      requestCount++;
      return { sequence: 1000 };
    },
    async getLedgerEntries() {
      requestCount++;
      return { entries: [] };
    },
    async simulateTransaction() {
      requestCount++;
      simulateCount++;
      if (options?.simulateDelayMs !== undefined) {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, options.simulateDelayMs);
          const signal = options.simulateSignal;
          if (signal) {
            if (signal.aborted) {
              clearTimeout(timer);
              reject(new Error("aborted"));
              return;
            }
            signal.addEventListener(
              "abort",
              () => {
                clearTimeout(timer);
                reject(new Error("aborted"));
              },
              { once: true },
            );
          }
        });
      }
      if (simulateCount === 2 && options?.enforcedSimulateResponse !== undefined) {
        return options.enforcedSimulateResponse;
      }
      return (
        options?.simulateResponse ?? {
          minResourceFee: "100",
          latestLedger: 123_456,
          result: {
            auth: [],
          },
          transactionData: {
            getReadOnly: () => [],
            getReadWrite: () => [],
          },
        }
      );
    },
  } as unknown as rpc.Server & { requestCount: number };
  return mock;
}

function createTestInterceptor(server: rpc.Server) {
  return new PreFlightInterceptor({
    server,
    networkPassphrase: "Test SDF Network ; September 2015",
    guard: VALID_GUARD,
    agent: Keypair.random(),
    source: Keypair.random(),
  });
}

describe("one-shot pre-flight helpers", () => {
  function config() {
    return {
      server: createMockServer(),
      networkPassphrase: "Test SDF Network ; September 2015",
      guard: VALID_GUARD,
      agent: Keypair.random(),
      source: Keypair.random(),
    };
  }

  it("preflight() constructs an interceptor and checks one call", async () => {
    const decision = await preflight(config(), validTransferCall());
    assert.equal(decision.kind, "admissible");
    assert.equal(decision.kind === "admissible" ? decision.provenance?.ledger : undefined, 123_456);
  });

  it("preflightBatch() constructs an interceptor and checks a batch", async () => {
    const decision = await preflightBatch(config(), []);
    assert.equal(decision.overallAdmissible, true);
    assert.equal(decision.calls.length, 0);
  });
});

describe("validateContractCall validator unit tests", () => {
  describe("contract format validation", () => {
    it("rejects missing or empty contract string", () => {
      assert.throws(
        () =>
          validateContractCall({ contract: unsafeContractAddress(""), fn: "transfer", args: [] }),
        (err: unknown) => {
          assert(err instanceof InvalidInputError);
          assert.equal(err.field, "contract");
          assert.equal(err.rule, "required");
          return true;
        },
      );
    });

    it("rejects non-StrKey or malformed contract IDs", () => {
      for (const bad of [
        "invalid-contract",
        "GAOBCRXTCO4ZCBNHALJUMJJ5JDXNOUZ7U6VZJX4UBTXAHQEO66IPU6PH",
        "C1234",
      ]) {
        assert.throws(
          () =>
            validateContractCall({
              contract: unsafeContractAddress(bad),
              fn: "transfer",
              args: [],
            }),
          (err: unknown) => {
            assert(err instanceof InvalidInputError);
            assert.equal(err.field, "contract");
            assert.equal(err.rule, "invalid_format");
            return true;
          },
        );
      }
    });

    it("accepts valid StrKey C... contract ID", () => {
      assert.doesNotThrow(() =>
        validateContractCall({ contract: VALID_TOKEN, fn: "balance", args: [] }),
      );
    });
  });

  describe("method presence and shape validation", () => {
    it("rejects missing or empty fn string", () => {
      assert.throws(
        () => validateContractCall({ contract: VALID_TOKEN, fn: "", args: [] }),
        (err: unknown) => {
          assert(err instanceof InvalidInputError);
          assert.equal(err.field, "fn");
          assert.equal(err.rule, "required");
          return true;
        },
      );
    });

    it("rejects method names with spaces, dashes, or special characters", () => {
      for (const bad of ["transfer tokens", "transfer-from", "transfer!"]) {
        assert.throws(
          () => validateContractCall({ contract: VALID_TOKEN, fn: bad, args: [] }),
          (err: unknown) => {
            assert(err instanceof InvalidInputError);
            assert.equal(err.field, "fn");
            assert.equal(err.rule, "symbol_shape");
            return true;
          },
        );
      }
    });

    it("rejects method names longer than Soroban 32-character symbol limit", () => {
      const toolong = "a".repeat(33);
      assert.throws(
        () => validateContractCall({ contract: VALID_TOKEN, fn: toolong, args: [] }),
        (err: unknown) => {
          assert(err instanceof InvalidInputError);
          assert.equal(err.field, "fn");
          assert.equal(err.rule, "symbol_shape");
          return true;
        },
      );
    });
  });

  describe("args array & ScVal type validation", () => {
    it("rejects non-array args", () => {
      assert.throws(
        () =>
          validateContractCall({
            contract: VALID_TOKEN,
            fn: "transfer",
            args: null as unknown as xdr.ScVal[],
          }),
        (err: unknown) => {
          assert(err instanceof InvalidInputError);
          assert.equal(err.field, "args");
          assert.equal(err.rule, "array");
          return true;
        },
      );
    });

    it("rejects args with non-ScVal elements", () => {
      assert.throws(
        () =>
          validateContractCall({
            contract: VALID_TOKEN,
            fn: "some_fn",
            args: ["not-an-scval" as unknown as xdr.ScVal],
          }),
        (err: unknown) => {
          assert(err instanceof InvalidInputError);
          assert.equal(err.field, "args");
          assert.equal(err.rule, "typed_scval");
          return true;
        },
      );
    });
  });

  describe("amount type validation for SAC operations", () => {
    it("rejects transfer with missing arguments", () => {
      assert.throws(
        () =>
          validateContractCall({
            contract: VALID_TOKEN,
            fn: "transfer",
            args: [new Address(VALID_GUARD).toScVal()],
          }),
        (err: unknown) => {
          assert(err instanceof InvalidInputError);
          assert.equal(err.field, "args");
          assert.equal(err.rule, "missing_argument");
          return true;
        },
      );
    });

    it("rejects transfer where amount is not an i128 ScVal", () => {
      assert.throws(
        () =>
          validateContractCall({
            contract: VALID_TOKEN,
            fn: "transfer",
            args: [
              new Address(VALID_GUARD).toScVal(),
              new Address(RECIPIENT).toScVal(),
              // non-i128 ScVal (u32)
              nativeToScVal(100, { type: "u32" }),
            ],
          }),
        (err: unknown) => {
          assert(err instanceof InvalidInputError);
          assert.equal(err.field, "amount");
          assert.equal(err.rule, "i128_type");
          return true;
        },
      );
    });

    it("rejects transfer where amount is raw non-ScVal string", () => {
      assert.throws(
        () =>
          validateContractCall({
            contract: VALID_TOKEN,
            fn: "transfer",
            args: [
              new Address(VALID_GUARD).toScVal(),
              new Address(RECIPIENT).toScVal(),
              "1000" as unknown as xdr.ScVal,
            ],
          }),
        (err: unknown) => {
          assert(err instanceof InvalidInputError);
          assert.equal(err.field, "amount");
          assert.equal(err.rule, "i128_type");
          return true;
        },
      );
    });

    it("rejects transfer_from where amount is not an i128 ScVal", () => {
      assert.throws(
        () =>
          validateContractCall({
            contract: VALID_TOKEN,
            fn: "transfer_from",
            args: [
              new Address(VALID_GUARD).toScVal(),
              new Address(VALID_GUARD).toScVal(),
              new Address(RECIPIENT).toScVal(),
              nativeToScVal("100", { type: "string" }),
            ],
          }),
        (err: unknown) => {
          assert(err instanceof InvalidInputError);
          assert.equal(err.field, "amount");
          assert.equal(err.rule, "i128_type");
          return true;
        },
      );
    });
  });
});

describe("interceptor.check() input validation and zero RPC round-trips", () => {
  it("throws InvalidInputError synchronously with 0 RPC requests on malformed contract ID", async () => {
    const mockServer = createMockServer();
    const interceptor = createTestInterceptor(mockServer);

    await assert.rejects(
      async () =>
        interceptor.check({
          contract: unsafeContractAddress("not-a-contract"),
          fn: "transfer",
          args: [],
        }),
      (err: unknown) => {
        assert(err instanceof InvalidInputError);
        assert.equal(err.field, "contract");
        assert.equal(err.rule, "invalid_format");
        return true;
      },
    );

    assert.equal(
      mockServer.requestCount,
      0,
      "No RPC calls should be attempted on invalid contract",
    );
  });

  it("throws InvalidInputError synchronously with 0 RPC requests on missing/invalid method", async () => {
    const mockServer = createMockServer();
    const interceptor = createTestInterceptor(mockServer);

    await assert.rejects(
      async () => interceptor.check({ contract: VALID_TOKEN, fn: "bad method name!", args: [] }),
      (err: unknown) => {
        assert(err instanceof InvalidInputError);
        assert.equal(err.field, "fn");
        assert.equal(err.rule, "symbol_shape");
        return true;
      },
    );

    assert.equal(mockServer.requestCount, 0, "No RPC calls should be attempted on invalid method");
  });

  it("throws InvalidInputError synchronously with 0 RPC requests on non-i128 amount", async () => {
    const mockServer = createMockServer();
    const interceptor = createTestInterceptor(mockServer);

    await assert.rejects(
      async () =>
        interceptor.check({
          contract: VALID_TOKEN,
          fn: "transfer",
          args: [
            new Address(VALID_GUARD).toScVal(),
            new Address(RECIPIENT).toScVal(),
            nativeToScVal(500, { type: "u64" }),
          ],
        }),
      (err: unknown) => {
        assert(err instanceof InvalidInputError);
        assert.equal(err.field, "amount");
        assert.equal(err.rule, "i128_type");
        return true;
      },
    );

    assert.equal(mockServer.requestCount, 0, "No RPC calls should be attempted on invalid amount");
  });
});

describe("abortSignal + timeoutMs plumbing", () => {
  it("already-aborted signal returns an undetermined verdict without any RPC call", async () => {
    const mockServer = createMockServer();
    const interceptor = createTestInterceptor(mockServer);
    const controller = new AbortController();
    controller.abort();

    // A verdict question is answered with a verdict: the guard reached no
    // decision, so the check fails closed on its `undetermined` arm instead of
    // throwing at the caller.
    const decision = await interceptor.check(validTransferCall(), { signal: controller.signal });

    assert.equal(decision.kind, "undetermined");
    const error = decision.error;
    assert.ok(error instanceof RpcTimeoutError);
    assert.equal(error.stage, "pre-flight");
    assert.equal(error.aborted, true);
    assert.equal(
      mockServer.requestCount,
      0,
      "No RPC calls should be attempted when signal is already aborted",
    );
  });

  it("mid-flight abort returns an undetermined verdict promptly", async () => {
    const controller = new AbortController();
    const mockServer = createMockServer({
      simulateDelayMs: 10_000,
      simulateSignal: controller.signal,
    });
    const interceptor = createTestInterceptor(mockServer);

    const started = Date.now();
    const pending = interceptor.check(validTransferCall(), { signal: controller.signal });
    setTimeout(() => controller.abort(), 10);
    const decision = await pending;

    assert.equal(decision.kind, "undetermined");
    const error = decision.error;
    assert.ok(error instanceof RpcTimeoutError);
    assert.equal(error.aborted, true, "a caller abort is reported as an abort, not a timeout");
    assert.ok(
      Date.now() - started < 5_000,
      "the verdict must arrive on the abort, not on the 10s simulation",
    );
  });

  it("timeoutMs fires a typed RpcTimeoutError as an undetermined verdict", async () => {
    const mockServer = createMockServer({ simulateDelayMs: 10_000 });
    const interceptor = createTestInterceptor(mockServer);

    const decision = await interceptor.check(validTransferCall(), { timeoutMs: 10 });

    assert.equal(decision.kind, "undetermined");
    const error = decision.error;
    assert.ok(error instanceof RpcTimeoutError);
    assert.equal(error.aborted, false);
    assert.equal(error.timeoutMs, 10);
    assert.equal(error.cause, "timeout");
  });

  it("a furnished signal that never fires leaves the verdict path untouched", async () => {
    const controller = new AbortController();
    const mockServer = createMockServer();
    const interceptor = createTestInterceptor(mockServer);

    const decision = await interceptor.check(validTransferCall(), {
      signal: controller.signal,
      timeoutMs: 30_000,
    });

    assert.equal(decision.kind, "admissible");
    assert.ok(mockServer.requestCount > 0);
  });
});

describe("boundary: valid-but-unusual inputs proceed to simulation", () => {
  it("allows unknown fn names to proceed to simulation (boundary: policy/contract question, not input shape)", async () => {
    const mockServer = createMockServer();
    const interceptor = createTestInterceptor(mockServer);

    // Unknown function name is symbol-shaped, so input validation passes.
    // Whether the contract implements it or policy allows it is an on-chain question for simulation.
    const call: ContractCall = {
      contract: VALID_TOKEN,
      fn: "unusual_arbitrary_call_v2",
      args: [],
    };

    assert.doesNotThrow(() => validateContractCall(call));
    const decision = await interceptor.check(call);
    assert.equal(decision.kind, "admissible");
    assert(mockServer.requestCount > 0, "Simulation RPC must be called for valid input shape");
  });

  it("allows huge amounts to proceed to simulation (boundary: cap/policy question, not input shape)", async () => {
    const mockServer = createMockServer();
    const interceptor = createTestInterceptor(mockServer);

    // Extremely large i128 amount is structurally valid.
    // Whether it exceeds spend caps is a policy question for simulation, not input validation.
    const hugeAmount = 999999999999999999999999999999999999n;
    const call = validTransferCall(hugeAmount);

    assert.doesNotThrow(() => validateContractCall(call));
    const decision = await interceptor.check(call);
    assert.equal(decision.kind, "admissible");
    assert(mockServer.requestCount > 0, "Simulation RPC must be called for valid amount type");
  });
});

describe("simulation ledger provenance (#347)", () => {
  it("reports the ledger from the same simulation that produced the quote", async () => {
    const mockServer = createMockServer();
    const interceptor = createTestInterceptor(mockServer);

    const decision = await interceptor.check(validTransferCall());

    assert.equal(decision.kind, "admissible");
    assert.deepEqual(decision.kind === "admissible" ? decision.provenance : undefined, {
      ledger: 123_456,
    });
  });

  it("omits provenance rather than inventing one when the response has no ledger", async () => {
    const mockServer = createMockServer({
      simulateResponse: {
        minResourceFee: "100",
        result: { auth: [] },
        transactionData: {
          getReadOnly: () => [],
          getReadWrite: () => [],
        },
      },
    });
    const interceptor = createTestInterceptor(mockServer);

    const decision = await interceptor.check(validTransferCall());

    assert.equal(decision.kind, "admissible");
    assert.equal(
      decision.kind === "admissible" ? decision.provenance : "not-admissible",
      undefined,
    );
  });

  it("omits a malformed ledger instead of passing it through", async () => {
    for (const latestLedger of [-1, 1.5, Number.NaN, "123", null]) {
      const mockServer = createMockServer({
        simulateResponse: {
          minResourceFee: "100",
          latestLedger,
          result: { auth: [] },
          transactionData: {
            getReadOnly: () => [],
            getReadWrite: () => [],
          },
        },
      });
      const interceptor = createTestInterceptor(mockServer);

      const decision = await interceptor.check(validTransferCall());

      assert.equal(decision.kind, "admissible");
      assert.equal(
        decision.kind === "admissible" ? decision.provenance : "not-admissible",
        undefined,
        `expected ${String(latestLedger)} to be omitted`,
      );
    }
  });

  it("never performs an additional ledger read to label the quote", async () => {
    let latestLedgerCalls = 0;
    const server = {
      getAccount: async () => ({ sequenceNumber: () => "100" }),
      getLatestLedger: async () => {
        latestLedgerCalls += 1;
        return { sequence: 999_999 };
      },
      simulateTransaction: async () => ({
        minResourceFee: "100",
        latestLedger: 500_000,
        result: { auth: [] },
        transactionData: {
          getReadOnly: () => [],
          getReadWrite: () => [],
        },
      }),
    } as unknown as rpc.Server;
    const interceptor = createTestInterceptor(server);

    const decision = await interceptor.check(validTransferCall());

    assert.equal(decision.kind, "admissible");
    assert.deepEqual(decision.kind === "admissible" ? decision.provenance : undefined, {
      ledger: 500_000,
    });
    // The check already reads the current ledger once for its cache context;
    // provenance must add no further read and must not use that value.
    assert.equal(latestLedgerCalls, 1, "provenance must come from the pricing simulation");
  });
});

describe("throw vs verdict contract asymmetry", () => {
  it("programmer error (invalid input) throws InvalidInputError", async () => {
    const mockServer = createMockServer();
    const interceptor = createTestInterceptor(mockServer);

    await assert.rejects(
      async () =>
        interceptor.check({ contract: unsafeContractAddress(""), fn: "transfer", args: [] }),
      InvalidInputError,
    );
  });

  it("policy refusal (blocked) returns a verdict without throwing", async () => {
    // Simulate a guard policy block (diagnostic event carries event_auth_checked, blocked, per_tx_cap_exceeded)
    const blockedErrorResponse = {
      error: "transaction failed",
      events: [
        {
          event: {
            contractId: VALID_GUARD,
            body: {
              v0: {
                topics: [
                  xdr.ScVal.scvSymbol("event_auth_checked"),
                  xdr.ScVal.scvSymbol("blocked"),
                  xdr.ScVal.scvSymbol("per_tx_cap_exceeded"),
                ],
                data: xdr.ScVal.scvMap([]),
              },
            },
          },
        },
      ],
    };

    const mockServer = createMockServer({ enforcedSimulateResponse: blockedErrorResponse });
    const interceptor = createTestInterceptor(mockServer);

    const call = validTransferCall(5000n);
    // check() does NOT throw: returns kind: "blocked"
    const decision = await interceptor.check(call);
    assert.equal(decision.allowed, false);
    assert.equal(decision.kind, "blocked");
    if (decision.kind === "blocked") {
      assert.equal(decision.reason, "per_tx_cap_exceeded");
      assert(decision.explanation.length > 0);
    }
  });

  it("assertAllowed throws GuardBlockedError carrying offending call and rawEvent on block", async () => {
    const blockedErrorResponse = {
      error: "transaction failed",
      events: [
        {
          event: {
            contractId: VALID_GUARD,
            body: {
              v0: {
                topics: [
                  xdr.ScVal.scvSymbol("event_auth_checked"),
                  xdr.ScVal.scvSymbol("blocked"),
                  xdr.ScVal.scvSymbol("recipient_not_allowed"),
                ],
                data: xdr.ScVal.scvMap([]),
              },
            },
          },
        },
      ],
    };

    const mockServer = createMockServer({ enforcedSimulateResponse: blockedErrorResponse });
    const interceptor = createTestInterceptor(mockServer);
    const call = validTransferCall(100n);

    await assert.rejects(
      async () => interceptor.assertAllowed(call),
      (err: unknown) => {
        assert(err instanceof GuardBlockedError);
        assert.equal(err.reason, "recipient_not_allowed");
        assert.equal(err.code, 21);
        assert.equal(err.stage, "preflight");
        assert.equal(err.charged, false);
        assert.deepEqual(err.call, call);
        assert.ok(err.rawEvent !== undefined);
        assert.match(err.explanation, /recipient/i);
        const json = err.toJSON();
        assert.equal(json["reason"], "recipient_not_allowed");
        assert.deepEqual(json["call"], {
          contract: call.contract,
          fn: call.fn,
          argsCount: 3,
        });
        return true;
      },
    );
  });
});

describe("assertAllowed and assertBatchAllowed behavior matrix & transport wrapping (issue #90)", () => {
  const call = validTransferCall(100n);

  it("assertAllowed: admissible verdict returns decision and does not throw", async () => {
    const interceptor = createTestInterceptor(createMockServer());
    const decision = await interceptor.assertAllowed(call);
    assert.equal(decision.allowed, true);
    assert.equal(decision.kind, "admissible");
  });

  it("assertAllowed: blocked verdict throws GuardBlockedError and extends GuardError", async () => {
    const blockedResponse = {
      error: "transaction failed",
      events: [
        {
          event: {
            contractId: VALID_GUARD,
            body: {
              v0: {
                topics: [
                  xdr.ScVal.scvSymbol("event_auth_checked"),
                  xdr.ScVal.scvSymbol("blocked"),
                  xdr.ScVal.scvSymbol("per_tx_cap_exceeded"),
                ],
                data: xdr.ScVal.scvMap([]),
              },
            },
          },
        },
      ],
    };
    const interceptor = createTestInterceptor(
      createMockServer({ enforcedSimulateResponse: blockedResponse }),
    );
    await assert.rejects(
      async () => interceptor.assertAllowed(call),
      (err: unknown) => {
        assert.ok(err instanceof GuardError, "must extend GuardError");
        assert.ok(err instanceof GuardBlockedError, "must be GuardBlockedError");
        assert.equal(err.reason, "per_tx_cap_exceeded");
        assert.equal(err.stage, "preflight");
        assert.deepEqual(err.call, call);
        return true;
      },
    );
  });

  it("assertAllowed: undetermined verdict throws GuardUndeterminedError and preserves underlying cause", async () => {
    const server = createMockServer({
      enforcedSimulateResponse: {
        minResourceFee: "not-a-fee",
        result: { auth: [] },
        transactionData: {
          getReadOnly: () => [],
          getReadWrite: () => [],
        },
      },
    });
    const interceptor = createTestInterceptor(server);
    await assert.rejects(
      async () => interceptor.assertAllowed(call),
      (err: unknown) => {
        assert.ok(err instanceof GuardError, "must extend GuardError");
        assert.ok(err instanceof GuardUndeterminedError, "must be GuardUndeterminedError");
        assert.ok(err instanceof PreFlightUndeterminedError, "must be backwards compatible alias");
        assert.equal(err.stage, "preflight");
        assert.ok(err.cause instanceof ContractResponseError, "must preserve cause");
        return true;
      },
    );
  });

  it("assertAllowed: wraps generic transport Error in GuardUndeterminedError preserving cause", async () => {
    const transportError = new Error("fetch failed: connection reset by peer");
    const server = {
      ...createMockServer(),
      async simulateTransaction() {
        throw transportError;
      },
    } as unknown as rpc.Server;
    const interceptor = createTestInterceptor(server);

    await assert.rejects(
      async () => interceptor.assertAllowed(call),
      (err: unknown) => {
        assert.ok(err instanceof GuardError, "must extend GuardError");
        assert.ok(err instanceof GuardUndeterminedError, "must be GuardUndeterminedError");
        // Transport error preserved either directly or via simulation error cause
        const underlying =
          err.cause === transportError ||
          (err.cause as { cause?: unknown })?.cause === transportError;
        assert.ok(underlying, "original Error must be preserved on cause");
        assert.match(err.message, /fetch failed: connection reset by peer/);
        assert.equal(err.stage, "preflight");
        return true;
      },
    );
  });

  it("assertAllowed: wraps raw uncaught Error from check in GuardUndeterminedError with direct cause", async () => {
    const interceptor = createTestInterceptor(createMockServer());
    const rawError = new Error("raw transport socket exploded");
    interceptor.check = async () => {
      throw rawError;
    };

    await assert.rejects(
      async () => interceptor.assertAllowed(call),
      (err: unknown) => {
        assert.ok(err instanceof GuardError);
        assert.ok(err instanceof GuardUndeterminedError);
        assert.strictEqual(err.cause, rawError);
        assert.match(err.message, /raw transport socket exploded/);
        return true;
      },
    );
  });

  it("assertAllowed: wraps non-Error throws in GuardUndeterminedError preserving cause", async () => {
    const interceptor = createTestInterceptor(createMockServer());
    interceptor.check = async () => {
      throw "raw socket error";
    };

    await assert.rejects(
      async () => interceptor.assertAllowed(call),
      (err: unknown) => {
        assert.ok(err instanceof GuardError, "must extend GuardError");
        assert.ok(err instanceof GuardUndeterminedError, "must be GuardUndeterminedError");
        assert.strictEqual(
          err.cause,
          "raw socket error",
          "primitive throw must be preserved on cause",
        );
        assert.match(err.message, /raw socket error/);
        assert.equal(err.stage, "preflight");
        return true;
      },
    );
  });

  it("assertAllowed: rethrows InvalidInputError programmer validation errors directly", async () => {
    const interceptor = createTestInterceptor(createMockServer());
    const invalidCall = { contract: "", fn: "", args: [] } as unknown as ContractCall;

    await assert.rejects(
      async () => interceptor.assertAllowed(invalidCall),
      (err: unknown) => {
        assert.ok(err instanceof InvalidInputError, "programmer error must not be wrapped");
        return true;
      },
    );
  });

  it("assertBatchAllowed: behavior matrix for admissible, blocked, undetermined, and transport failure", async () => {
    // 1. All admissible
    const interceptor = createTestInterceptor(createMockServer());
    const batchRes = await interceptor.assertBatchAllowed([call]);
    assert.equal(batchRes.overallAdmissible, true);

    // 2. Blocked in batch throws GuardBlockedError
    const blockedResponse = {
      error: "transaction failed",
      events: [
        {
          event: {
            contractId: VALID_GUARD,
            body: {
              v0: {
                topics: [
                  xdr.ScVal.scvSymbol("event_auth_checked"),
                  xdr.ScVal.scvSymbol("blocked"),
                  xdr.ScVal.scvSymbol("recipient_not_allowed"),
                ],
                data: xdr.ScVal.scvMap([]),
              },
            },
          },
        },
      ],
    };
    const blockedInterceptor = createTestInterceptor(
      createMockServer({ enforcedSimulateResponse: blockedResponse }),
    );
    await assert.rejects(
      async () => blockedInterceptor.assertBatchAllowed([call]),
      (err: unknown) => {
        assert.ok(err instanceof GuardBlockedError);
        assert.equal(err.reason, "recipient_not_allowed");
        return true;
      },
    );

    // 3. Undetermined in batch throws GuardUndeterminedError
    const undeterminedInterceptor = createTestInterceptor(
      createMockServer({
        enforcedSimulateResponse: {
          minResourceFee: "invalid-fee",
          result: { auth: [] },
          transactionData: { getReadOnly: () => [], getReadWrite: () => [] },
        },
      }),
    );
    await assert.rejects(
      async () => undeterminedInterceptor.assertBatchAllowed([call]),
      (err: unknown) => {
        assert.ok(err instanceof GuardUndeterminedError);
        assert.ok(err.cause instanceof ContractResponseError);
        return true;
      },
    );

    // 4. Raw transport error during batch throws wrapped GuardUndeterminedError
    const transportErr = new Error("batch network down");
    const failingInterceptor = createTestInterceptor(createMockServer());
    failingInterceptor.checkBatch = async () => {
      throw transportErr;
    };
    await assert.rejects(
      async () => failingInterceptor.assertBatchAllowed([call]),
      (err: unknown) => {
        assert.ok(err instanceof GuardUndeterminedError);
        assert.strictEqual(err.cause, transportErr);
        return true;
      },
    );
  });
});

/* -------------------------------------------------------------------------- */
/*             Pre-flight resource-fee handling (fail closed)                 */
/* -------------------------------------------------------------------------- */

/**
 * A malformed resource fee must fail the way every other malformed contract
 * response fails: with the SDK's typed `ContractResponseError`, naming the
 * field and the stage, and with the verdict `undetermined` — never
 * `admissible`, because an unpriceable simulation must not produce a budget
 * decision.
 */
describe("pre-flight resource-fee handling", () => {
  function serverWithFee(minResourceFee: unknown) {
    return createMockServer({
      enforcedSimulateResponse: {
        minResourceFee,
        result: { auth: [] },
        transactionData: {
          getReadOnly: () => [],
          getReadWrite: () => [],
        },
      },
    });
  }

  it("reports a missing, malformed, negative or out-of-range fee as undetermined", async () => {
    for (const value of [undefined, null, "", "not-a-fee", "1.5", -1, 2n ** 64n]) {
      const server = serverWithFee(value);
      const interceptor = createTestInterceptor(server);

      const decision = await interceptor.check(validTransferCall());

      assert.equal(decision.kind, "undetermined");
      assert.ok(
        decision.error instanceof ContractResponseError,
        `expected a ContractResponseError for ${String(value)}`,
      );
      assert.equal(decision.error.field, "minResourceFee");
      assert.equal(decision.error.stage, "preflight");
      assert.equal(decision.allowed, false);
    }
  });

  it("accepts the fee in every representation the SDK may hand back", async () => {
    for (const value of ["42", 42, 42n]) {
      const server = serverWithFee(value);
      const interceptor = createTestInterceptor(server);

      const decision = await interceptor.check(validTransferCall());

      assert.equal(decision.kind, "admissible");
      assert.equal(decision.kind === "admissible" ? decision.estimatedResourceFee : undefined, 42n);
    }
  });
});

/* -------------------------------------------------------------------------- */
/*             Unit tests for opt-in pre-flight simulation cache              */
/* -------------------------------------------------------------------------- */
const CONTRACT = unsafeContractAddress("CAPADGEK457RHKN4RYVUMDJTFHDSG7R5HREQONKLYK7MFKC5WFENPP44");
const OTHER_CONTRACT = unsafeContractAddress(Address.contract(Buffer.alloc(32)).toString());
const NETWORK_PASSPHRASE = "Test SDF Network ; September 2015";
const CALL: ContractCall = { contract: CONTRACT, fn: "noop", args: [] };

function makeHarness() {
  let simulations = 0;
  let latestLedgerCalls = 0;
  let ledger = 100;
  const source = Keypair.random();
  const server = {
    getAccount: async () => new Account(source.publicKey(), "1"),
    getLatestLedger: async () => {
      latestLedgerCalls += 1;
      return { sequence: ledger };
    },
    simulateTransaction: async () => {
      simulations += 1;
      return {
        result: { auth: [] },
        minResourceFee: "17",
        transactionData: {
          getReadOnly: () => [],
          getReadWrite: () => [{}],
        },
      };
    },
  } as unknown as rpc.Server;

  return {
    server,
    source,
    call: CALL,
    get simulations() {
      return simulations;
    },
    get latestLedgerCalls() {
      return latestLedgerCalls;
    },
    advanceLedger() {
      ledger += 1;
    },
  };
}

function makeInterceptor(
  harness: ReturnType<typeof makeHarness>,
  options: { cache?: PreFlightCacheOptions; clock?: Clock } = {},
): PreFlightInterceptor {
  return new PreFlightInterceptor({
    server: harness.server,
    networkPassphrase: NETWORK_PASSPHRASE,
    guard: CONTRACT,
    agent: harness.source,
    source: harness.source,
    ...(options.cache ? { cache: options.cache } : {}),
    ...(options.clock ? { clock: options.clock } : {}),
  });
}

/** A distinct call fingerprint per amount, for exercising cache cardinality. */
function callWithAmount(amount: bigint): ContractCall {
  return {
    contract: CONTRACT,
    fn: "noop",
    args: [nativeToScVal(amount, { type: "i128" })],
  };
}

describe("PreFlightInterceptor simulation cache", () => {
  it("does not cache unless explicitly enabled", async () => {
    const harness = makeHarness();
    const interceptor = makeInterceptor(harness);

    await interceptor.check(harness.call);
    await interceptor.check(harness.call);

    assert.equal(harness.simulations, 4);
    // No cache-context ledger lookup is added to the default path.
    assert.equal(harness.latestLedgerCalls, 2);
  });

  it("returns a hit for the same call within the ledger window", async () => {
    const harness = makeHarness();
    const interceptor = makeInterceptor(harness, { cache: { ttlMs: 5_000 } });

    const first = await interceptor.check(harness.call);
    const second = await interceptor.check(harness.call);

    assert.equal(harness.simulations, 2);
    assert.equal(harness.latestLedgerCalls, 3);
    // A hit carries cache provenance (#409), so it is a new object with the
    // same decision, not the same reference. `storedAt` makes the age exact.
    assert.equal(second.kind, first.kind);
    assert.equal(second.cached, true);

    const stats = interceptor.getCacheStats();
    assert.equal(stats.hits, 1);
    assert.equal(stats.misses, 1);
    assert.equal(stats.size, 1);
    assert.equal(stats.invalidations, 0);
  });

  it("supports ledger-based TTL configuration", async () => {
    const harness = makeHarness();
    const interceptor = makeInterceptor(harness, { cache: { ttlLedgers: 1 } });

    await interceptor.check(harness.call);
    await interceptor.check(harness.call);

    assert.equal(harness.simulations, 2);
  });

  it("does not reuse a verdict after its TTL expires", async () => {
    const harness = makeHarness();
    const interceptor = makeInterceptor(harness, { cache: { ttlMs: 1 } });

    await interceptor.check(harness.call);
    await new Promise((resolve) => setTimeout(resolve, 10));
    await interceptor.check(harness.call);

    assert.equal(harness.simulations, 4);
  });

  it("invalidates the complete cache explicitly", async () => {
    const harness = makeHarness();
    const interceptor = makeInterceptor(harness, { cache: { ttlMs: 5_000 } });

    await interceptor.check(harness.call);
    interceptor.invalidate();
    await interceptor.check(harness.call);

    assert.equal(harness.simulations, 4);

    const stats = interceptor.getCacheStats();
    assert.equal(stats.hits, 0); // first call: miss, invalidate, second call: miss
    assert.equal(stats.misses, 2); // both calls are misses
    assert.equal(stats.size, 1); // cache populated by second call after invalidate
    assert.equal(stats.invalidations, 1); // one invalidation call cleared one entry
  });

  it("invalidates only the requested call when one is supplied", async () => {
    const harness = makeHarness();
    const interceptor = makeInterceptor(harness, { cache: { ttlMs: 5_000 } });
    const otherCall: ContractCall = {
      contract: CONTRACT,
      fn: "noop",
      args: [nativeToScVal(1n, { type: "i128" })],
    };

    await interceptor.check(harness.call);
    await interceptor.check(otherCall);
    interceptor.invalidate(harness.call);
    await interceptor.check(harness.call);
    await interceptor.check(otherCall);

    assert.equal(harness.simulations, 6);
  });

  it("invalidates when the ledger advances", async () => {
    const harness = makeHarness();
    const interceptor = makeInterceptor(harness, { cache: { ttlMs: 5_000 } });

    await interceptor.check(harness.call);
    harness.advanceLedger();
    await interceptor.check(harness.call);

    assert.equal(harness.simulations, 4);

    const stats = interceptor.getCacheStats();
    assert.equal(stats.hits, 0);
    assert.equal(stats.misses, 2);
    assert.equal(stats.size, 1);
    assert.equal(stats.invalidations, 0);
  });

  it("invalidates when the policy revision changes", async () => {
    const harness = makeHarness();
    let revision = 1;
    const interceptor = makeInterceptor(harness, {
      cache: { ttlMs: 5_000, policyRevision: () => revision },
    });

    await interceptor.check(harness.call);
    revision = 2;
    await interceptor.check(harness.call);

    assert.equal(harness.simulations, 4);
  });

  it("bypasses the cache when a supplied policy revision is unreadable", async () => {
    const harness = makeHarness();
    const interceptor = makeInterceptor(harness, {
      cache: { ttlMs: 5_000, policyRevision: () => undefined },
    });

    await interceptor.check(harness.call);
    await interceptor.check(harness.call);

    assert.equal(harness.simulations, 4);
  });

  it("uses different keys for different arguments", async () => {
    const harness = makeHarness();
    const interceptor = makeInterceptor(harness, { cache: { ttlMs: 5_000 } });
    const otherCall: ContractCall = {
      contract: CONTRACT,
      fn: "noop",
      args: [nativeToScVal(1n, { type: "i128" })],
    };

    await interceptor.check(harness.call);
    await interceptor.check(otherCall);

    assert.equal(harness.simulations, 4);
  });

  it("uses different keys for different functions", async () => {
    const harness = makeHarness();
    const interceptor = makeInterceptor(harness, { cache: { ttlMs: 5_000 } });
    const otherCall: ContractCall = { ...harness.call, fn: "other" };

    await interceptor.check(harness.call);
    await interceptor.check(otherCall);

    assert.equal(harness.simulations, 4);
  });

  it("uses different keys for different contracts", async () => {
    const harness = makeHarness();
    const interceptor = makeInterceptor(harness, { cache: { ttlMs: 5_000 } });
    const otherCall: ContractCall = { ...harness.call, contract: OTHER_CONTRACT };

    await interceptor.check(harness.call);
    await interceptor.check(otherCall);

    assert.equal(harness.simulations, 4);
  });

  it("does not cache an undetermined result", async () => {
    const source = Keypair.random();
    let simulations = 0;
    const server = {
      getAccount: async () => new Account(source.publicKey(), "1"),
      getLatestLedger: async () => ({ sequence: 100 }),
      simulateTransaction: async () => {
        simulations += 1;
        return { error: "HostError: trap" };
      },
    } as unknown as rpc.Server;
    const interceptor = new PreFlightInterceptor({
      server,
      networkPassphrase: NETWORK_PASSPHRASE,
      guard: CONTRACT,
      agent: source,
      source,
      cache: { ttlMs: 5_000 },
    });

    await interceptor.check(CALL);
    await interceptor.check(CALL);

    assert.equal(simulations, 2);
  });

  it("rejects a cache configuration without a positive TTL", () => {
    const harness = makeHarness();
    assert.throws(() => makeInterceptor(harness, { cache: {} }), /requires ttlMs or ttlLedgers/);
    assert.throws(
      () => makeInterceptor(harness, { cache: { ttlMs: 0 } }),
      /ttlMs must be a positive finite number/,
    );
  });

  it("evicts the least-recently-used verdict when maxEntries is reached", async () => {
    const harness = makeHarness();
    const interceptor = makeInterceptor(harness, { cache: { ttlMs: 5_000, maxEntries: 2 } });
    const first = callWithAmount(1n);
    const second = callWithAmount(2n);
    const third = callWithAmount(3n);

    await interceptor.check(first); // cache: [first]
    await interceptor.check(second); // cache: [first, second]
    await interceptor.check(first); // hit, recency: [second, first]
    await interceptor.check(third); // miss, evicts second: [first, third]
    assert.equal(harness.simulations, 6);

    await interceptor.check(first); // still cached
    assert.equal(harness.simulations, 6);
    await interceptor.check(second); // was evicted, so it is re-simulated
    assert.equal(harness.simulations, 8);
  });

  it("bounds the cache size under many unique calls", async () => {
    const harness = makeHarness();
    const maxEntries = 8;
    const interceptor = makeInterceptor(harness, { cache: { ttlMs: 5_000, maxEntries } });
    const calls = Array.from({ length: 100 }, (_, index) => callWithAmount(BigInt(index + 1)));

    for (const call of calls) await interceptor.check(call);
    assert.equal(harness.simulations, 200);

    // The bound holds after far more unique fingerprints than it can store.
    const cacheSize = (interceptor as unknown as { cache: Map<string, unknown> }).cache.size;
    assert.equal(cacheSize, maxEntries);

    // The newest `maxEntries` verdicts survive; the oldest are gone.
    await interceptor.check(calls[calls.length - 1]!);
    assert.equal(harness.simulations, 200);
    await interceptor.check(calls[calls.length - 1 - maxEntries]!);
    assert.equal(harness.simulations, 202);
  });

  it("keeps explicit invalidation complete while bounded", async () => {
    const harness = makeHarness();
    const interceptor = makeInterceptor(harness, { cache: { ttlMs: 5_000, maxEntries: 2 } });
    const first = callWithAmount(1n);
    const second = callWithAmount(2n);

    await interceptor.check(first);
    await interceptor.check(second);
    interceptor.invalidate();
    await interceptor.check(first);
    await interceptor.check(second);

    assert.equal(harness.simulations, 8);
  });

  it("keeps per-call invalidation precise while bounded", async () => {
    const harness = makeHarness();
    const interceptor = makeInterceptor(harness, { cache: { ttlMs: 5_000, maxEntries: 2 } });
    const first = callWithAmount(1n);
    const second = callWithAmount(2n);

    await interceptor.check(first);
    await interceptor.check(second);
    interceptor.invalidate(first);
    await interceptor.check(first); // re-simulated
    await interceptor.check(second); // still cached

    assert.equal(harness.simulations, 6);
  });

  it("never serves an expired or cross-ledger verdict under eviction pressure", async () => {
    const harness = makeHarness();
    const clock = new FakeClock(1_000);
    const interceptor = makeInterceptor(harness, {
      cache: { ttlMs: 1, maxEntries: 2 },
      clock,
    });
    const first = callWithAmount(1n);
    const second = callWithAmount(2n);

    await interceptor.check(first);
    await interceptor.check(second);

    // The TTL lapses while both fingerprints are still within the bound.
    clock.advance(2);
    await interceptor.check(first); // expired: must re-simulate, never reuse
    assert.equal(harness.simulations, 6);

    // A ledger advance discards the refreshed verdict even though the bound
    // has room to keep it.
    harness.advanceLedger();
    await interceptor.check(first);
    assert.equal(harness.simulations, 8);
  });

  it("rejects an invalid maxEntries", () => {
    const harness = makeHarness();
    for (const maxEntries of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      assert.throws(
        () => makeInterceptor(harness, { cache: { ttlMs: 5_000, maxEntries } }),
        /maxEntries must be a positive integer/,
      );
    }
  });
});

/* -------------------------------------------------------------------------- */

/**
 * The cached path honours the caller's bound exactly like the uncached one.
 *
 * The cache's ledger lookup is an RPC the check makes, so it carries the same
 * abort/timeout semantics as the enforcement pipeline: an already-aborted
 * signal issues no RPC at all, a stalled lookup is bounded rather than waited
 * on, and a cache failure only falls back to the uncached path while that path
 * is still inside the caller's bound.
 */
describe("PreFlightInterceptor cached checks honour the caller's bound", () => {
  /** A cached check whose ledger lookup can be stalled or made to fail. */
  function makeCacheHarness(options: { ledger?: "ok" | "stall" | "fail-cache-read" } = {}) {
    const source = Keypair.random();
    let simulations = 0;
    let latestLedgerCalls = 0;
    const server = {
      getAccount: async () => new Account(source.publicKey(), "1"),
      getLatestLedger: async () => {
        latestLedgerCalls += 1;
        if (options.ledger === "stall") {
          // A ledger read that never answers. The check must not wait on it.
          return new Promise<{ sequence: number }>(() => {});
        }
        if (options.ledger === "fail-cache-read" && latestLedgerCalls === 1) {
          // The cache's own lookup fails. The enforcement run reads the ledger
          // too (for the signature expiry), and that read still succeeds.
          throw new Error("ledger read failed");
        }
        return { sequence: 100 };
      },
      simulateTransaction: async () => {
        simulations += 1;
        return {
          result: { auth: [] },
          minResourceFee: "17",
          transactionData: { getReadOnly: () => [], getReadWrite: () => [{}] },
        };
      },
    } as unknown as rpc.Server;

    return {
      server,
      source,
      call: CALL,
      get simulations() {
        return simulations;
      },
      get latestLedgerCalls() {
        return latestLedgerCalls;
      },
    };
  }

  function makeCachedInterceptor(
    harness: ReturnType<typeof makeCacheHarness>,
    cache: PreFlightCacheOptions = { ttlMs: 5_000 },
  ): PreFlightInterceptor {
    return new PreFlightInterceptor({
      server: harness.server,
      networkPassphrase: NETWORK_PASSPHRASE,
      guard: CONTRACT,
      agent: harness.source,
      source: harness.source,
      cache,
    });
  }

  /**
   * Await `work`, but fail the test instead of hanging when it never settles.
   *
   * A stalled RPC used to leave the check pending forever; without this guard
   * that regression would hang the suite instead of failing it.
   */
  async function settleWithin<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        work,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`${what} did not settle within ${ms}ms`)), ms);
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  it("issues no RPC at all when the caller's signal is already aborted", async () => {
    const harness = makeCacheHarness();
    const interceptor = makeCachedInterceptor(harness);
    const controller = new AbortController();
    controller.abort();

    const decision = await interceptor.check(harness.call, { signal: controller.signal });

    assert.equal(decision.kind, "undetermined");
    assert.ok(decision.error instanceof RpcTimeoutError);
    assert.equal(decision.error.aborted, true);
    // Neither the cache's ledger read nor a simulation is issued.
    assert.equal(harness.latestLedgerCalls, 0);
    assert.equal(harness.simulations, 0);
  });

  it("returns an undetermined timeout verdict when the ledger lookup stalls", async () => {
    const harness = makeCacheHarness({ ledger: "stall" });
    const interceptor = makeCachedInterceptor(harness);
    const startedAt = Date.now();

    const decision = await settleWithin(
      interceptor.check(harness.call, { timeoutMs: 25 }),
      2_000,
      "the check",
    );

    assert.equal(decision.kind, "undetermined");
    assert.ok(decision.error instanceof RpcTimeoutError);
    assert.equal(decision.error.aborted, false);
    assert.equal(decision.error.timeoutMs, 25);
    assert.equal(decision.error.stage, "pre-flight");
    // The stalled read is bounded, not awaited: the check resolves promptly
    // instead of hanging on an RPC that will never answer.
    assert.ok(Date.now() - startedAt < 2_000, "the check must not wait on a stalled ledger read");
    // The uncached enforcement path is not entered once the bound has fired.
    assert.equal(harness.latestLedgerCalls, 1);
    assert.equal(harness.simulations, 0);
  });

  it("falls back to the uncached path when the ledger read fails", async () => {
    const harness = makeCacheHarness({ ledger: "fail-cache-read" });
    const interceptor = makeCachedInterceptor(harness);

    const decision = await interceptor.check(harness.call);

    // A failed cache lookup is not a security decision: the uncached
    // enforcement path runs and prices the call.
    assert.equal(decision.kind, "admissible");
    assert.equal(harness.latestLedgerCalls, 2);
    assert.equal(harness.simulations, 2);
  });

  it("does not enter the uncached path once the caller's signal has fired", async () => {
    const controller = new AbortController();
    const harness = makeCacheHarness();
    const interceptor = new PreFlightInterceptor({
      server: harness.server,
      networkPassphrase: NETWORK_PASSPHRASE,
      guard: CONTRACT,
      agent: harness.source,
      source: harness.source,
      cache: {
        ttlMs: 5_000,
        // The revision read fails *and* the caller gives up while it is in
        // flight: the cache cannot be consulted, and the uncached path is no
        // longer inside the caller's bound.
        policyRevision: () => {
          controller.abort();
          throw new Error("revision unavailable");
        },
      },
    });

    const decision = await interceptor.check(harness.call, { signal: controller.signal });

    assert.equal(decision.kind, "undetermined");
    assert.ok(decision.error instanceof RpcTimeoutError);
    assert.equal(decision.error.aborted, true);
    // No ledger read and no simulation: a caller that gave up gets no work.
    assert.equal(harness.latestLedgerCalls, 0);
    assert.equal(harness.simulations, 0);
  });

  it("still serves a cached verdict from a bounded ledger lookup", async () => {
    const harness = makeCacheHarness();
    const interceptor = makeCachedInterceptor(harness);

    const first = await interceptor.check(harness.call, { timeoutMs: 1_000 });
    const second = await interceptor.check(harness.call, { timeoutMs: 1_000 });

    assert.equal(first.kind, "admissible");
    assert.equal(second.kind, first.kind);
    assert.equal(second.cached, true);
    // The second check reused the cached verdict: one ledger read for the
    // cache context, one inside the enforcement run, and no new simulation.
    assert.equal(harness.latestLedgerCalls, 3);
    assert.equal(harness.simulations, 2);
    assert.equal(interceptor.getCacheStats().hits, 1);
  });
});

/* -------------------------------------------------------------------------- */

/**
 * In-flight coalescing: concurrent checks for the same call share one
 * discovery/enforcement run, without turning into a durable cache and without
 * letting one caller's bound cancel another caller's result.
 */
describe("PreFlightInterceptor in-flight coalescing", () => {
  function deferred<T = void>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  }

  function admissibleSimulation() {
    return {
      result: { auth: [] },
      minResourceFee: "17",
      transactionData: { getReadOnly: () => [], getReadWrite: () => [{}] },
    };
  }

  function makeHarness(options: { rejected?: boolean } = {}) {
    const source = Keypair.random();
    const gate = deferred();
    const probeStarted = deferred();
    let simulations = 0;
    const server = {
      getAccount: async () => new Account(source.publicKey(), "1"),
      getLatestLedger: async () => ({ sequence: 100 }),
      simulateTransaction: async () => {
        simulations += 1;
        if (simulations === 1) probeStarted.resolve();
        await gate.promise;
        return options.rejected ? { error: "HostError: trap" } : admissibleSimulation();
      },
    } as unknown as rpc.Server;
    return {
      server,
      source,
      probeStarted: probeStarted.promise,
      release: () => gate.resolve(),
      get simulations() {
        return simulations;
      },
    };
  }

  function makeInterceptor(harness: ReturnType<typeof makeHarness>) {
    return new PreFlightInterceptor({
      server: harness.server,
      networkPassphrase: NETWORK_PASSPHRASE,
      guard: VALID_GUARD,
      agent: harness.source,
      source: harness.source,
    });
  }

  it("runs one discovery/enforcement pass for concurrent identical calls", async () => {
    const harness = makeHarness();
    const interceptor = makeInterceptor(harness);
    const call = validTransferCall(10n);

    const first = interceptor.check(call);
    const second = interceptor.check(call);
    await harness.probeStarted;
    harness.release();

    const [firstDecision, secondDecision] = await Promise.all([first, second]);
    assert.equal(firstDecision.kind, "admissible");
    assert.equal(secondDecision.kind, "admissible");
    // One probe plus one enforced simulation, not two of each.
    assert.equal(harness.simulations, 2);
    assert.equal(secondDecision, firstDecision);

    // The settled entry is gone: the next call runs its own pass.
    await new Promise((resolve) => setImmediate(resolve));
    const later = await interceptor.check(call);
    assert.equal(later.kind, "admissible");
    assert.equal(harness.simulations, 4);
  });

  it("can be disabled per interceptor", async () => {
    const harness = makeHarness();
    const interceptor = new PreFlightInterceptor({
      server: harness.server,
      networkPassphrase: NETWORK_PASSPHRASE,
      guard: VALID_GUARD,
      agent: harness.source,
      source: harness.source,
      coalesceInFlight: false,
    });
    const call = validTransferCall(10n);

    const first = interceptor.check(call);
    const second = interceptor.check(call);
    harness.release();

    const [firstDecision, secondDecision] = await Promise.all([first, second]);
    assert.equal(firstDecision.kind, "admissible");
    assert.equal(secondDecision.kind, "admissible");
    assert.equal(harness.simulations, 4);
  });

  it("does not coalesce distinct calls", async () => {
    const harness = makeHarness();
    const interceptor = makeInterceptor(harness);

    const first = interceptor.check(validTransferCall(10n));
    const second = interceptor.check(validTransferCall(20n));
    harness.release();

    const [firstDecision, secondDecision] = await Promise.all([first, second]);
    assert.equal(firstDecision.kind, "admissible");
    assert.equal(secondDecision.kind, "admissible");
    assert.equal(harness.simulations, 4);
  });

  it("keeps a waiter's result when another waiter's signal aborts", async () => {
    const harness = makeHarness();
    const interceptor = makeInterceptor(harness);
    const call = validTransferCall(10n);
    const controller = new AbortController();

    const aborted = interceptor.check(call, { signal: controller.signal });
    const patient = interceptor.check(call);
    await harness.probeStarted;

    controller.abort();
    harness.release();

    const [abortedDecision, patientDecision] = await Promise.all([aborted, patient]);
    assert.equal(abortedDecision.kind, "undetermined");
    assert.ok(abortedDecision.error instanceof RpcTimeoutError);
    assert.equal(abortedDecision.error.aborted, true);
    // The abort cancelled one waiter's wait, not the shared run.
    assert.equal(patientDecision.kind, "admissible");
    assert.equal(harness.simulations, 2);
  });

  it("removes a rejected run and never persists its undetermined outcome", async () => {
    const harness = makeHarness({ rejected: true });
    const interceptor = makeInterceptor(harness);
    const call = validTransferCall(10n);

    const first = interceptor.check(call);
    const second = interceptor.check(call);
    await harness.probeStarted;
    harness.release();

    const [firstDecision, secondDecision] = await Promise.all([first, second]);
    assert.equal(firstDecision.kind, "undetermined");
    assert.equal(secondDecision.kind, "undetermined");
    assert.equal(harness.simulations, 1);

    // A settled failure is removed, not cached: the next call runs again.
    await new Promise((resolve) => setImmediate(resolve));
    const third = await interceptor.check(call);
    assert.equal(third.kind, "undetermined");
    assert.equal(harness.simulations, 2);
  });
});

/* -------------------------------------------------------------------------- */

/**
 * Batched pre-flight: the all-or-nothing aggregate over a list of calls.
 *
 * The single-call path is mocked RPC; what these tests pin is the *staging* on
 * top of it — that the aggregate is admissible only when every call is, that a
 * call which passes alone can still be refused once the batch's cumulative
 * window spend is accounted for, and that a refusal anywhere is never averaged
 * away. `window_cap_exceeded` is synthesised client-side from staged amounts,
 * so the reasoning behind it is asserted explicitly rather than assumed.
 */
describe("PreFlightInterceptor.checkBatch()", () => {
  const PASSPHRASE = "Test SDF Network ; September 2015";

  /** An enforced simulation that passes, priced at `minResourceFee` stroops. */
  function admissibleSimulation(feeStroops: string) {
    return {
      result: { auth: [] },
      minResourceFee: feeStroops,
      transactionData: { getReadOnly: () => [], getReadWrite: () => [{}] },
    };
  }

  /** A guard refusal in the contract's own vocabulary. */
  function blockedSimulation() {
    return {
      error: "blocked",
      events: [
        {
          event: {
            contractId: CONTRACT,
            body: {
              v0: {
                topics: [
                  xdr.ScVal.scvSymbol("event_auth_checked"),
                  xdr.ScVal.scvSymbol("blocked"),
                  xdr.ScVal.scvSymbol("per_tx_cap_exceeded"),
                ],
                data: xdr.ScVal.scvVoid(),
              },
            },
          },
        },
      ],
    };
  }

  /**
   * A server whose enforced simulation (every 2nd call) is scripted per
   * 1-based enforced-run index, so a batch can mix admissible and refused calls.
   */
  function batchServer(options: {
    enforcedRuns: readonly unknown[];
    ledgerEntries?: () => unknown;
  }) {
    let simulations = 0;
    let enforcedRun = 0;
    const server = {
      getAccount: async () => new Account(Keypair.random().publicKey(), "1"),
      getLatestLedger: async () => ({ sequence: 100 }),
      simulateTransaction: async () => {
        simulations += 1;
        if (simulations % 2 === 0) {
          const scripted = options.enforcedRuns[enforcedRun];
          enforcedRun += 1;
          return scripted ?? admissibleSimulation("10");
        }
        return admissibleSimulation("10");
      },
      ...(options.ledgerEntries ? { getLedgerEntries: async () => options.ledgerEntries?.() } : {}),
    } as unknown as rpc.Server;
    return {
      server,
      get simulations() {
        return simulations;
      },
    };
  }

  function transferCall(amount: bigint): ContractCall {
    return {
      contract: VALID_TOKEN,
      fn: "transfer",
      args: [
        new Address(VALID_GUARD).toScVal(),
        new Address(RECIPIENT).toScVal(),
        nativeToScVal(amount, { type: "i128" }),
      ],
    };
  }

  /** A policy that objects to nothing except the window cap under test. */
  function policyWithWindowCap(windowCap: bigint): PolicyConfig {
    return {
      per_tx_cap: 1_000_000_000_000n,
      window_secs: 86_400n,
      window_cap: windowCap,
      assets: [VALID_TOKEN],
      protocols: [],
      recipients: [RECIPIENT],
      allow_any_recipient: true,
      active_from: 0n,
      active_until: 0n,
      paused: false,
      dms_grace_secs: 3_600n,
    };
  }

  function batchInterceptor(
    server: rpc.Server,
    policy?: PolicyConfig | null,
  ): PreFlightInterceptor {
    return new PreFlightInterceptor({
      server,
      networkPassphrase: PASSPHRASE,
      guard: CONTRACT,
      agent: Keypair.random(),
      source: Keypair.random(),
      ...(policy !== undefined ? { policy } : {}),
    });
  }

  /** Narrow a verdict to its blocked arm, or fail with its actual kind. */
  function blockedArm(verdict: PreFlightDecision | undefined) {
    assert.ok(verdict, "expected a verdict for this call");
    assert.equal(verdict.kind, "blocked", `expected blocked, got ${verdict.kind}`);
    return verdict;
  }

  it("treats an empty batch as admissible with no fee and no verdicts", async () => {
    const harness = batchServer({ enforcedRuns: [] });
    const decision = await batchInterceptor(harness.server).checkBatch([]);

    assert.equal(decision.admissible, true);
    assert.equal(decision.overallAdmissible, true);
    assert.deepEqual(decision.verdicts, []);
    assert.deepEqual(decision.calls, decision.verdicts);
    assert.equal(decision.totalEstimatedResourceFee, 0n);
    assert.equal(harness.simulations, 0);
  });

  it("returns one verdict per call, in input order, and sums the admissible fees", async () => {
    const harness = batchServer({
      enforcedRuns: [admissibleSimulation("10"), admissibleSimulation("25")],
    });
    const calls = [transferCall(10n), transferCall(20n)];

    const decision = await batchInterceptor(harness.server, policyWithWindowCap(1_000n)).checkBatch(
      calls,
      { initialWindowSpent: 0n },
    );

    assert.equal(decision.admissible, true);
    assert.equal(decision.verdicts.length, 2);
    assert.deepEqual(
      decision.verdicts.map((verdict) => verdict.kind),
      ["admissible", "admissible"],
    );
    // 10 + 25, summed from the per-call estimates.
    assert.equal(decision.totalEstimatedResourceFee, 35n);
    // Two simulations per call: the probe and the enforced run.
    assert.equal(harness.simulations, 4);
  });

  it("refuses a call that passes alone but breaches the staged window cap", async () => {
    // Both calls pass in isolation: 60n and 60n against a 100n cap.
    const { server } = batchServer({
      enforcedRuns: [admissibleSimulation("10"), admissibleSimulation("10")],
    });
    const decision = await batchInterceptor(server, policyWithWindowCap(100n)).checkBatch(
      [transferCall(60n), transferCall(60n)],
      { initialWindowSpent: 0n },
    );

    assert.equal(decision.admissible, false);
    assert.equal(decision.overallAdmissible, false);
    assert.equal(decision.verdicts[0]?.kind, "admissible");
    const staged = blockedArm(decision.verdicts[1]);
    // The refusal names the window cap and shows the arithmetic, so the caller
    // can see *why* a call the chain would have allowed was staged out.
    assert.equal(staged.reason, "window_cap_exceeded");
    assert.match(staged.detail, /120 > window_cap 100/);
    // A staged-out call is never charged to the batch's fee total.
    assert.equal(decision.totalEstimatedResourceFee, 10n);
  });

  it("counts the committed window spend already on the ledger against the cap", async () => {
    const { server } = batchServer({
      enforcedRuns: [admissibleSimulation("10"), admissibleSimulation("10")],
    });
    // 90n already committed leaves room for exactly one 10n transfer, not two.
    const decision = await batchInterceptor(server, policyWithWindowCap(100n)).checkBatch(
      [transferCall(10n), transferCall(10n)],
      { initialWindowSpent: 90n },
    );

    assert.equal(decision.admissible, false);
    assert.equal(decision.verdicts[0]?.kind, "admissible");
    assert.equal(decision.verdicts[1]?.kind, "blocked");
  });

  it("propagates a contract refusal and makes the whole batch inadmissible", async () => {
    const { server } = batchServer({
      enforcedRuns: [admissibleSimulation("10"), blockedSimulation()],
    });
    const decision = await batchInterceptor(server, policyWithWindowCap(1_000n)).checkBatch(
      [transferCall(10n), transferCall(20n)],
      { initialWindowSpent: 0n },
    );

    assert.equal(decision.admissible, false);
    // The guard's own reason survives, decoded from its diagnostic.
    assert.equal(blockedArm(decision.verdicts[1]).reason, "per_tx_cap_exceeded");
    assert.equal(decision.totalEstimatedResourceFee, 10n);
  });

  it("skips window staging when no window cap is configured", async () => {
    const { server } = batchServer({
      enforcedRuns: [admissibleSimulation("10"), admissibleSimulation("10")],
    });
    // A `null` cap must mean "no objection", not "refuse everything".
    const decision = await batchInterceptor(server, null).checkBatch(
      [transferCall(1_000_000n), transferCall(1_000_000n)],
      { initialWindowSpent: 0n },
    );

    assert.equal(decision.admissible, true);
    assert.deepEqual(
      decision.verdicts.map((verdict) => verdict.kind),
      ["admissible", "admissible"],
    );
  });

  it("fails closed when a required live staging read fails", async () => {
    // Without an explicit snapshot, a failed ledger read means the committed
    // window spend is unknown. Staging against an assumed zero could label an
    // over-cap batch admissible, so the transfer cannot be decided.
    const harness = batchServer({
      enforcedRuns: [admissibleSimulation("10"), admissibleSimulation("10")],
      ledgerEntries: () => {
        throw new Error("rpc unavailable");
      },
    });
    const decision = await batchInterceptor(harness.server, policyWithWindowCap(1_000n)).checkBatch(
      [transferCall(10n), transferCall(20n)],
    );

    assert.equal(decision.admissible, false);
    assert.equal(decision.kind, "undetermined");
    assert.equal(decision.staging?.source, "unavailable");
    assert.equal(decision.staging?.windowSpent, null);
    assert.equal(decision.staging?.unavailable, true);
    assert.equal(decision.verdicts.length, 2);
    assert.equal(decision.verdicts[0]?.kind, "undetermined");
    assert.equal(decision.verdicts[1]?.kind, "undetermined");
    assert.match(
      decision.verdicts[0]!.kind === "undetermined" ? decision.verdicts[0]!.detail : "",
      /committed window spend/,
    );
  });

  it("treats an absent Window entry as zero committed spend, not a failed read", async () => {
    const harness = batchServer({
      enforcedRuns: [admissibleSimulation("10"), admissibleSimulation("10")],
      ledgerEntries: () => ({ entries: [] }),
    });
    // The policy is supplied (cap 100) but the committed spend is read from the
    // ledger: an absent entry means 0n, so 60 + 40 lands exactly on the cap.
    const decision = await batchInterceptor(harness.server, policyWithWindowCap(100n)).checkBatch([
      transferCall(60n),
      transferCall(40n),
    ]);

    assert.equal(decision.admissible, true);
    assert.equal(decision.kind, "admissible");
    assert.equal(decision.staging?.source, "absent");
    assert.equal(decision.staging?.windowSpent, 0n);
    assert.equal(decision.staging?.unavailable, false);
  });

  it("trusts an explicitly supplied zero snapshot even when the live read fails", async () => {
    const harness = batchServer({
      enforcedRuns: [admissibleSimulation("10"), admissibleSimulation("10")],
      ledgerEntries: () => {
        throw new Error("rpc unavailable");
      },
    });
    const decision = await batchInterceptor(harness.server, policyWithWindowCap(1_000n)).checkBatch(
      [transferCall(10n), transferCall(20n)],
      { initialWindowSpent: 0n },
    );

    assert.equal(decision.admissible, true);
    assert.equal(decision.kind, "admissible");
    assert.equal(decision.staging?.source, "provided");
    assert.equal(decision.staging?.windowSpent, 0n);
    assert.equal(decision.staging?.unavailable, false);
  });

  it("does not need window state for a batch with only non-transfer calls", async () => {
    const harness = batchServer({
      enforcedRuns: [admissibleSimulation("10")],
      ledgerEntries: () => {
        throw new Error("rpc unavailable");
      },
    });
    const decision = await batchInterceptor(harness.server).checkBatch([
      { contract: VALID_TOKEN, fn: "balance", args: [new Address(VALID_GUARD).toScVal()] },
    ]);

    // Staging is not required, so an unavailable window read cannot change the
    // verdict for a call that never touches the window.
    assert.equal(decision.admissible, true);
    assert.equal(decision.kind, "admissible");
    assert.equal(decision.staging, undefined);
  });

  it("reads the live policy and window from ledger storage when none is supplied", async () => {
    // `readPersistentEntry` decodes the contract-data entry's ScVal; the batch
    // check then stages against the committed total it finds there.
    const harness = batchServer({
      enforcedRuns: [admissibleSimulation("10")],
      ledgerEntries: () => ({ entries: [] }),
    });
    const decision = await batchInterceptor(harness.server).checkBatch([transferCall(10n)]);

    assert.equal(decision.admissible, true);
    assert.equal(decision.staging?.source, "absent");
  });

  it("assertBatchAllowed returns the batch when every call is admissible", async () => {
    const { server } = batchServer({ enforcedRuns: [admissibleSimulation("10")] });
    const batch = await batchInterceptor(server, policyWithWindowCap(1_000n)).assertBatchAllowed(
      [transferCall(10n)],
      { initialWindowSpent: 0n },
    );

    assert.equal(batch.admissible, true);
  });

  it("assertBatchAllowed throws GuardBlockedError on the first refusal", async () => {
    const { server } = batchServer({ enforcedRuns: [blockedSimulation()] });
    const interceptor = batchInterceptor(server, policyWithWindowCap(1_000n));

    await assert.rejects(
      interceptor.assertBatchAllowed([transferCall(10n)], { initialWindowSpent: 0n }),
      (error: unknown) => {
        assert.ok(error instanceof GuardBlockedError);
        assert.equal(error.reason, "per_tx_cap_exceeded");
        return true;
      },
    );
  });

  it("assertBatchAllowed throws PreFlightUndeterminedError on an undetermined call", async () => {
    // A host rejection is not the guard refusing, and it is not the batch
    // staging either: it must surface as undetermined, never as a block.
    const { server } = batchServer({
      enforcedRuns: [{ error: "HostError: invalid_input", events: [] }],
    });
    const interceptor = batchInterceptor(server, policyWithWindowCap(1_000n));

    await assert.rejects(
      interceptor.assertBatchAllowed([transferCall(10n)], { initialWindowSpent: 0n }),
      (error: unknown) => {
        assert.ok(error instanceof PreFlightUndeterminedError);
        return true;
      },
    );
  });

  it("assertBatchAllowed throws PreFlightUndeterminedError when staging state is unavailable", async () => {
    const { server } = batchServer({
      enforcedRuns: [admissibleSimulation("10")],
      ledgerEntries: () => {
        throw new Error("rpc unavailable");
      },
    });
    const interceptor = batchInterceptor(server, policyWithWindowCap(1_000n));

    await assert.rejects(interceptor.assertBatchAllowed([transferCall(10n)]), (error: unknown) => {
      assert.ok(error instanceof PreFlightUndeterminedError);
      assert.match((error as Error).message, /batch staging state unavailable/);
      return true;
    });
  });

  /**
   * Cumulative staging boundaries (issue #337).
   *
   * The explicit matrix below pins the three arithmetic boundaries the cap can
   * have, and the seeded case explores mixed batches so ordering, non-transfer
   * calls, and individual blocked/undetermined verdicts cannot be averaged
   * away. The seed is printed in the failure, and the iteration count is kept
   * small so the mock-RPC suite stays fast in CI.
   */
  describe("cumulative staging boundaries (issue #337)", () => {
    const STAGING_SEED = 0x5eed337;
    const STAGING_ITERATIONS = 50;

    type ForcedKind = "admissible" | "blocked" | "undetermined";

    interface Member {
      call: ContractCall;
      forced: ForcedKind;
      /** Transfer amount, or `null` for a non-transfer call. */
      amount: bigint | null;
    }

    function nonTransferCall(): ContractCall {
      return {
        contract: VALID_TOKEN,
        fn: "balance",
        args: [new Address(VALID_GUARD).toScVal()],
      };
    }

    function forcedRun(kind: ForcedKind): unknown {
      if (kind === "blocked") return blockedSimulation();
      if (kind === "undetermined") return { error: "HostError: invalid_input", events: [] };
      return admissibleSimulation("10");
    }

    /** Run one batch and return the verdict kinds plus the fee total. */
    async function runBatch(
      members: readonly Member[],
      windowCap: bigint,
      initialWindowSpent: bigint,
    ) {
      const { server } = batchServer({
        enforcedRuns: members.map((member) => forcedRun(member.forced)),
      });
      const decision = await batchInterceptor(server, policyWithWindowCap(windowCap)).checkBatch(
        members.map((member) => member.call),
        { initialWindowSpent },
      );
      return decision;
    }

    function expectedVerdicts(
      members: readonly Member[],
      windowCap: bigint,
      initialWindowSpent: bigint,
    ): { kinds: string[]; fee: bigint } {
      let staged = 0n;
      let fee = 0n;
      const kinds = members.map((member) => {
        if (member.forced === "blocked") return "blocked";
        if (member.forced === "undetermined") return "undetermined";
        if (member.amount !== null && member.amount > 0n && windowCap > 0n) {
          const projected = initialWindowSpent + staged + member.amount;
          if (projected > windowCap) return "blocked";
          staged += member.amount;
        }
        fee += 10n;
        return "admissible";
      });
      return { kinds, fee };
    }

    function describeFailure(
      seed: number,
      iteration: number,
      members: readonly Member[],
      windowCap: bigint,
      initialWindowSpent: bigint,
    ): string {
      const replay = JSON.stringify({ windowCap, initialWindowSpent, members }, (_key, value) =>
        typeof value === "bigint" ? value.toString() : value,
      );
      return `seed 0x${seed.toString(16)} iteration ${iteration}\nbatch: ${replay}`;
    }

    it("admits below and equal to the cap, and refuses one stroop above", async () => {
      const cases: Array<{ amounts: bigint[]; expected: string[] }> = [
        { amounts: [99n], expected: ["admissible"] },
        { amounts: [100n], expected: ["admissible"] },
        { amounts: [101n], expected: ["blocked"] },
        { amounts: [60n, 40n], expected: ["admissible", "admissible"] },
        { amounts: [60n, 41n], expected: ["admissible", "blocked"] },
        { amounts: [50n, 49n], expected: ["admissible", "admissible"] },
        { amounts: [50n, 51n], expected: ["admissible", "blocked"] },
      ];

      for (const boundary of cases) {
        const members = boundary.amounts.map(
          (amount): Member => ({
            call: transferCall(amount),
            forced: "admissible",
            amount,
          }),
        );
        const decision = await runBatch(members, 100n, 0n);
        assert.deepEqual(
          decision.verdicts.map((verdict) => verdict.kind),
          boundary.expected,
          `amounts ${boundary.amounts.join(" + ")} against cap 100`,
        );
        assert.equal(
          decision.admissible,
          !boundary.expected.includes("blocked"),
          "only a fully admissible batch is admissible",
        );
      }
    });

    it("keeps staging order-dependent and ignores non-transfer calls", async () => {
      const ordered = [
        { amounts: [101n, 50n], expected: ["blocked", "admissible"] },
        { amounts: [50n, 101n], expected: ["admissible", "blocked"] },
        { amounts: [60n, 40n], expected: ["admissible", "admissible"] },
        { amounts: [60n, 41n], expected: ["admissible", "blocked"] },
      ];

      for (const boundary of ordered) {
        const members = boundary.amounts.map(
          (amount): Member => ({ call: transferCall(amount), forced: "admissible", amount }),
        );
        const decision = await runBatch(members, 100n, 0n);
        assert.deepEqual(
          decision.verdicts.map((verdict) => verdict.kind),
          boundary.expected,
          `ordered amounts ${boundary.amounts.join(", ")}`,
        );
      }

      const mixed: Member[] = [
        { call: transferCall(60n), forced: "admissible", amount: 60n },
        { call: nonTransferCall(), forced: "admissible", amount: null },
        { call: transferCall(40n), forced: "admissible", amount: 40n },
      ];
      const mixedDecision = await runBatch(mixed, 100n, 0n);
      assert.deepEqual(
        mixedDecision.verdicts.map((verdict) => verdict.kind),
        ["admissible", "admissible", "admissible"],
      );
      assert.equal(mixedDecision.totalEstimatedResourceFee, 30n);

      const overMixed = await runBatch(
        [
          { call: transferCall(60n), forced: "admissible", amount: 60n },
          { call: nonTransferCall(), forced: "admissible", amount: null },
          { call: transferCall(41n), forced: "admissible", amount: 41n },
        ],
        100n,
        0n,
      );
      assert.deepEqual(
        overMixed.verdicts.map((verdict) => verdict.kind),
        ["admissible", "admissible", "blocked"],
      );
    });

    it("never upgrades an individual blocked or undetermined member", async () => {
      const members: Member[] = [
        { call: transferCall(1n), forced: "blocked", amount: 1n },
        { call: transferCall(60n), forced: "admissible", amount: 60n },
        { call: transferCall(1n), forced: "undetermined", amount: 1n },
        { call: transferCall(40n), forced: "admissible", amount: 40n },
      ];
      const decision = await runBatch(members, 100n, 0n);

      assert.deepEqual(
        decision.verdicts.map((verdict) => verdict.kind),
        ["blocked", "admissible", "undetermined", "admissible"],
      );
      assert.equal(decision.admissible, false);
      assert.equal(decision.kind, "blocked");
      // The 60 + 40 transfers still stage to exactly the cap; neither is
      // upgraded by the blocked or undetermined member around them.
      assert.equal(decision.totalEstimatedResourceFee, 20n);
    });

    it("matches a seeded generator of mixed batches", async () => {
      const rand = mulberry32(STAGING_SEED);

      for (let iteration = 0; iteration < STAGING_ITERATIONS; iteration += 1) {
        const windowCap = [0n, 1n, 10n, 100n, 1_000n][Math.floor(rand() * 5)]!;
        const initialWindowSpent =
          rand() < 0.5 ? 0n : randomUint(rand, Math.min(12, windowCap.toString(2).length + 1));
        const length = 1 + Math.floor(rand() * 5);
        let staged = 0n;
        const members: Member[] = [];

        for (let index = 0; index < length; index += 1) {
          if (rand() < 0.2) {
            members.push({ call: nonTransferCall(), forced: "admissible", amount: null });
            continue;
          }

          const kindRoll = rand();
          const forced: ForcedKind =
            kindRoll < 0.15 ? "blocked" : kindRoll < 0.3 ? "undetermined" : "admissible";

          let amount: bigint;
          if (forced !== "admissible") {
            amount = 1n;
          } else {
            const remaining = windowCap - initialWindowSpent - staged;
            const boundaryRoll = rand();
            if (boundaryRoll < 0.15) {
              amount = remaining > 0n ? remaining - 1n : 0n;
            } else if (boundaryRoll < 0.3) {
              amount = remaining > 0n ? remaining : 0n;
            } else if (boundaryRoll < 0.45) {
              amount = remaining >= 0n ? remaining + 1n : 1n;
            } else {
              amount = randomUint(rand, 32) % 1_000n;
            }
          }

          members.push({ call: transferCall(amount), forced, amount });

          if (
            forced === "admissible" &&
            amount > 0n &&
            windowCap > 0n &&
            initialWindowSpent + staged + amount <= windowCap
          ) {
            staged += amount;
          }
        }

        const expected = expectedVerdicts(members, windowCap, initialWindowSpent);

        try {
          const decision = await runBatch(members, windowCap, initialWindowSpent);
          assert.deepEqual(
            decision.verdicts.map((verdict) => verdict.kind),
            expected.kinds,
            "staged verdict kinds",
          );
          assert.equal(decision.totalEstimatedResourceFee, expected.fee, "admissible fee total");
          assert.equal(
            decision.admissible,
            !expected.kinds.includes("blocked") && !expected.kinds.includes("undetermined"),
            "batch must not upgrade a blocked/undetermined member",
          );
        } catch (error) {
          assert.fail(
            `${describeFailure(
              STAGING_SEED,
              iteration,
              members,
              windowCap,
              initialWindowSpent,
            )}\nexpected kinds: ${expected.kinds.join(", ")}\n${
              error instanceof Error ? (error.stack ?? error.message) : String(error)
            }`,
          );
        }
      }
    });
  });
});

describe("PreFlightInterceptor concurrency limit and 429 handling (issue #40)", () => {
  const PASSPHRASE = "Test SDF Network ; September 2015";

  /** A 429 as the SDK's HTTP client surfaces it (axios-style). */
  function rateLimitError(retryAfter?: string): Error {
    return Object.assign(new Error("Request failed with status code 429"), {
      response: {
        status: 429,
        headers: retryAfter === undefined ? {} : { "retry-after": retryAfter },
      },
    });
  }

  const okSimulation = {
    minResourceFee: "100",
    latestLedger: 123_456,
    result: { auth: [] },
    transactionData: { getReadOnly: () => [], getReadWrite: () => [] },
  };

  /**
   * A transport that records how many checks are in flight at once. Every check
   * runs exactly two simulations on one transaction sequence number, so a check
   * is "in flight" from its first simulation start to its second one finishing.
   */
  function instrumentedServer(options: { delayMs?: number } = {}) {
    const active = new Set<string>();
    const seen = new Map<string, number>();
    let peak = 0;
    const server = {
      async getAccount() {
        return { sequenceNumber: () => "100" };
      },
      async getLatestLedger() {
        return { sequence: 1000 };
      },
      async simulateTransaction(tx: { sequence: string }) {
        const key = tx.sequence;
        const count = (seen.get(key) ?? 0) + 1;
        seen.set(key, count);
        active.add(key);
        peak = Math.max(peak, active.size);
        await new Promise((resolve) => setTimeout(resolve, options.delayMs ?? 5));
        if (count === 2) active.delete(key);
        return okSimulation;
      },
    } as unknown as rpc.Server;
    return {
      server,
      get peak() {
        return peak;
      },
    };
  }

  function interceptorFor(server: rpc.Server, extra: Record<string, unknown> = {}) {
    return new PreFlightInterceptor({
      server,
      networkPassphrase: PASSPHRASE,
      guard: VALID_GUARD,
      agent: Keypair.random(),
      source: Keypair.random(),
      coalesceInFlight: false,
      ...extra,
    });
  }

  it("keeps at most the configured number of simulations in flight across 20 parallel checks", async () => {
    const transport = instrumentedServer();
    const interceptor = interceptorFor(transport.server, { maxConcurrentSimulations: 3 });
    const decisions = await Promise.all(
      Array.from({ length: 20 }, (_, i) => interceptor.check(validTransferCall(BigInt(i + 1)))),
    );
    assert.ok(
      decisions.every((d) => d.kind === "admissible"),
      "every queued check must still get its verdict",
    );
    assert.ok(transport.peak >= 2, `limit should be reached, peak ${transport.peak}`);
    assert.ok(transport.peak <= 3, `at most 3 in flight, saw ${transport.peak}`);
  });

  it("defaults to 4 concurrent simulations", async () => {
    const transport = instrumentedServer();
    const interceptor = interceptorFor(transport.server);
    await Promise.all(
      Array.from({ length: 20 }, (_, i) => interceptor.check(validTransferCall(BigInt(i + 1)))),
    );
    assert.equal(DEFAULT_MAX_CONCURRENT_SIMULATIONS, 4);
    assert.ok(transport.peak <= 4, `default limit is 4, saw ${transport.peak}`);
  });

  it("is observably unbounded when the limit is raised (the instrument can see overlap)", async () => {
    const transport = instrumentedServer();
    const interceptor = interceptorFor(transport.server, { maxConcurrentSimulations: 100 });
    await Promise.all(
      Array.from({ length: 20 }, (_, i) => interceptor.check(validTransferCall(BigInt(i + 1)))),
    );
    assert.ok(transport.peak > 4, `expected overlap above 4, saw ${transport.peak}`);
  });

  it("rejects an unusable limit or backoff at construction", () => {
    const { server } = instrumentedServer();
    for (const bad of [0, -1, 1.5, Number.NaN]) {
      assert.throws(() => interceptorFor(server, { maxConcurrentSimulations: bad }), TypeError);
    }
    assert.throws(() => interceptorFor(server, { rateLimit: { backoffMs: -1 } }), TypeError);
    assert.throws(
      () => interceptorFor(server, { rateLimit: { maxBackoffMs: Number.NaN } }),
      TypeError,
    );
  });

  it("does not let a queued check that timed out take a slot later", async () => {
    let started = 0;
    const server = {
      async getAccount() {
        return { sequenceNumber: () => "100" };
      },
      async getLatestLedger() {
        return { sequence: 1000 };
      },
      async simulateTransaction() {
        started++;
        await new Promise((resolve) => setTimeout(resolve, 60));
        return okSimulation;
      },
    } as unknown as rpc.Server;
    const interceptor = interceptorFor(server, { maxConcurrentSimulations: 1 });
    const first = interceptor.check(validTransferCall(1n));
    const second = await interceptor.check(validTransferCall(2n), { timeoutMs: 10 });
    assert.equal(second.kind, "undetermined");
    assert.ok(second.kind === "undetermined" && second.error instanceof RpcTimeoutError);
    assert.equal((await first).kind, "admissible");
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(started, 2, "only the first check's two simulations ran");
  });

  /** A server whose first `failures` simulations are rate limited. */
  function limitedServer(failures: number, retryAfter?: string) {
    let calls = 0;
    const server = {
      async getAccount() {
        return { sequenceNumber: () => "100" };
      },
      async getLatestLedger() {
        return { sequence: 1000 };
      },
      async simulateTransaction() {
        calls++;
        if (calls <= failures) throw rateLimitError(retryAfter);
        return okSimulation;
      },
    } as unknown as rpc.Server;
    return { server, calls: () => calls };
  }

  function recordingClock() {
    const slept: number[] = [];
    const clock: Clock = {
      now: () => Date.now(),
      sleep: async (ms: number) => {
        slept.push(ms);
      },
    };
    return { clock, slept };
  }

  it("waits once on a first 429 and then succeeds", async () => {
    const { server } = limitedServer(1);
    const { clock, slept } = recordingClock();
    const decision = await interceptorFor(server, { clock }).check(validTransferCall());
    assert.equal(decision.kind, "admissible");
    assert.deepEqual(slept, [500], "one bounded default backoff");
  });

  it("honours Retry-After, capped at maxBackoffMs", async () => {
    const short = recordingClock();
    await interceptorFor(limitedServer(1, "2").server, { clock: short.clock }).check(
      validTransferCall(),
    );
    assert.deepEqual(short.slept, [2000]);

    const long = recordingClock();
    await interceptorFor(limitedServer(1, "3600").server, {
      clock: long.clock,
      rateLimit: { maxBackoffMs: 1500 },
    }).check(validTransferCall());
    assert.deepEqual(long.slept, [1500]);
  });

  it("returns undetermined with cause rate_limited when the 429 persists", async () => {
    const { server, calls } = limitedServer(Number.POSITIVE_INFINITY, "1");
    const { clock, slept } = recordingClock();
    const decision = await interceptorFor(server, { clock }).check(validTransferCall());
    assert.equal(decision.kind, "undetermined");
    assert.equal(decision.allowed, false);
    if (decision.kind !== "undetermined") return;
    assert.equal(decision.cause, "rate_limited");
    assert.ok(decision.error instanceof RateLimitedError);
    assert.equal(decision.error.kind, "rate_limited");
    assert.equal(decision.error.retryAfterMs, 1000);
    assert.equal(decision.error.attempts, 2);
    assert.deepEqual(slept, [1000], "exactly one backoff, not a retry loop");
    assert.equal(calls(), 2, "one retry only");
  });

  it("does not tag other failures as rate limited and does not retry them", async () => {
    let calls = 0;
    const server = {
      async getAccount() {
        return { sequenceNumber: () => "100" };
      },
      async getLatestLedger() {
        return { sequence: 1000 };
      },
      async simulateTransaction() {
        calls++;
        throw Object.assign(new Error("boom"), { response: { status: 500 } });
      },
    } as unknown as rpc.Server;
    const { clock, slept } = recordingClock();
    const decision = await interceptorFor(server, { clock }).check(validTransferCall());
    assert.equal(decision.kind, "undetermined");
    assert.ok(decision.kind === "undetermined" && decision.cause === undefined);
    assert.equal(calls, 1);
    assert.deepEqual(slept, []);
  });
});

/* -------------------------------------------------------------------------- */
/*      Cache provenance / forceFresh (#409) and onVerdict observer (#408)    */
/* -------------------------------------------------------------------------- */

function observedInterceptor(
  server: rpc.Server,
  events: PreFlightVerdictEvent[],
  extra: { cache?: PreFlightCacheOptions; clock?: Clock; onVerdict?: () => void } = {},
): PreFlightInterceptor {
  return new PreFlightInterceptor({
    server,
    networkPassphrase: NETWORK_PASSPHRASE,
    guard: CONTRACT,
    agent: Keypair.random(),
    source: Keypair.random(),
    onVerdict: extra.onVerdict ? extra.onVerdict : (event) => events.push(event),
    ...(extra.cache ? { cache: extra.cache } : {}),
    ...(extra.clock ? { clock: extra.clock } : {}),
  });
}

describe("cached verdict provenance and forceFresh (#409)", () => {
  it("leaves a fresh decision's shape unchanged", async () => {
    const harness = makeHarness();
    const interceptor = makeInterceptor(harness, { cache: { ttlMs: 5_000 } });

    const decision = await interceptor.check(harness.call);

    assert.equal(decision.cached, undefined);
    assert.equal(decision.observedLedger, undefined);
    assert.equal(decision.ageMs, undefined);
  });

  it("reports the ledger and exact age on a cache hit", async () => {
    const harness = makeHarness();
    const clock = new FakeClock(1_000);
    const interceptor = makeInterceptor(harness, { cache: { ttlMs: 5_000 }, clock });

    await interceptor.check(harness.call);
    clock.advance(250);
    const hit = await interceptor.check(harness.call);

    assert.equal(hit.kind, "admissible");
    assert.equal(hit.cached, true);
    assert.equal(hit.observedLedger, 100);
    assert.equal(hit.ageMs, 250);
  });

  it("ages a hit from its own store time, not the first hit's", async () => {
    const harness = makeHarness();
    const clock = new FakeClock(1_000);
    const interceptor = makeInterceptor(harness, { cache: { ttlMs: 5_000 }, clock });

    await interceptor.check(harness.call);
    clock.advance(100);
    const firstHit = await interceptor.check(harness.call);
    clock.advance(200);
    const secondHit = await interceptor.check(harness.call);

    assert.equal(firstHit.ageMs, 100);
    assert.equal(secondHit.ageMs, 300);
    assert.equal(firstHit.ageMs, 100, "an earlier hit's age must not be rewritten");
  });

  it("does not treat the provenance fields as part of the decision", async () => {
    const harness = makeHarness();
    const interceptor = makeInterceptor(harness, { cache: { ttlMs: 5_000 } });

    const fresh = await interceptor.check(harness.call);
    const hit = await interceptor.check(harness.call);
    const { cached, observedLedger, ageMs, ...hitDecision } = hit;

    assert.equal(cached, true);
    assert.ok(observedLedger !== undefined);
    assert.ok(ageMs !== undefined);
    assert.deepEqual(hitDecision, fresh);
  });

  it("forceFresh always simulates and leaves the cache untouched", async () => {
    const harness = makeHarness();
    const interceptor = makeInterceptor(harness, { cache: { ttlMs: 5_000 } });

    await interceptor.check(harness.call);
    assert.equal(harness.simulations, 2);

    const fresh = await interceptor.check(harness.call, { forceFresh: true });
    assert.equal(harness.simulations, 4, "forceFresh must run a new simulation");
    assert.equal(fresh.cached, undefined);
    assert.equal(interceptor.getCacheStats().hits, 0);

    const hit = await interceptor.check(harness.call);
    assert.equal(hit.cached, true, "forceFresh must not evict the cached verdict");
    assert.equal(harness.simulations, 4);
  });

  it("forceFresh works with no cache configured", async () => {
    const harness = makeHarness();
    const interceptor = makeInterceptor(harness);

    const decision = await interceptor.check(harness.call, { forceFresh: true });

    assert.equal(decision.kind, "admissible");
    assert.equal(decision.cached, undefined);
    assert.equal(harness.simulations, 2);
  });

  it("TTL expiry and ledger advance return fresh decisions without provenance", async () => {
    const harness = makeHarness();
    const clock = new FakeClock(1_000);
    const interceptor = makeInterceptor(harness, { cache: { ttlMs: 100 }, clock });

    await interceptor.check(harness.call);
    clock.advance(500);
    const afterTtl = await interceptor.check(harness.call);
    assert.equal(afterTtl.cached, undefined);

    harness.advanceLedger();
    const afterLedger = await interceptor.check(harness.call);
    assert.equal(afterLedger.cached, undefined);
    assert.equal(harness.simulations, 6);
  });
});

describe("onVerdict observer (#408)", () => {
  it("fires once for an admissible verdict with call identity and no arguments", async () => {
    const events: PreFlightVerdictEvent[] = [];
    const interceptor = observedInterceptor(createMockServer(), events);
    const call = validTransferCall();

    await interceptor.check(call);

    assert.equal(events.length, 1);
    const [event] = events;
    assert.equal(event?.kind, "admissible");
    assert.equal(event?.cached, false);
    assert.deepEqual(event?.call, { contract: call.contract, fn: call.fn });
    assert.equal(Object.keys(event!.call).includes("args"), false);
    assert.equal(typeof event?.durationMs, "number");
    assert.ok(event!.durationMs >= 0);
    assert.equal(event?.reason, undefined);
  });

  it("fires once for a blocked verdict with the contract reason", async () => {
    const blockedResponse = {
      error: "transaction failed",
      events: [
        {
          event: {
            contractId: VALID_GUARD,
            body: {
              v0: {
                topics: [
                  xdr.ScVal.scvSymbol("event_auth_checked"),
                  xdr.ScVal.scvSymbol("blocked"),
                  xdr.ScVal.scvSymbol("per_tx_cap_exceeded"),
                ],
                data: xdr.ScVal.scvMap([]),
              },
            },
          },
        },
      ],
    };
    const events: PreFlightVerdictEvent[] = [];
    const interceptor = observedInterceptor(
      createMockServer({ enforcedSimulateResponse: blockedResponse }),
      events,
    );

    const decision = await interceptor.check(validTransferCall());

    assert.equal(decision.kind, "blocked");
    assert.equal(events.length, 1);
    assert.equal(events[0]?.kind, "blocked");
    assert.equal(events[0]?.reason, "per_tx_cap_exceeded");
  });

  it("fires once for an undetermined verdict", async () => {
    const server = {
      async getAccount() {
        return { sequenceNumber: () => "100" };
      },
      async getLatestLedger() {
        return { sequence: 1000 };
      },
      async simulateTransaction() {
        throw new Error("rpc down");
      },
    } as unknown as rpc.Server;
    const events: PreFlightVerdictEvent[] = [];
    const interceptor = observedInterceptor(server, events);

    const decision = await interceptor.check(validTransferCall());

    assert.equal(decision.kind, "undetermined");
    assert.equal(events.length, 1);
    assert.equal(events[0]?.kind, "undetermined");
  });

  it("fires on a cache hit and reports it as cached with the ledger", async () => {
    const harness = makeHarness();
    const events: PreFlightVerdictEvent[] = [];
    const interceptor = new PreFlightInterceptor({
      server: harness.server,
      networkPassphrase: NETWORK_PASSPHRASE,
      guard: CONTRACT,
      agent: harness.source,
      source: harness.source,
      cache: { ttlMs: 5_000 },
      onVerdict: (event) => events.push(event),
    });

    await interceptor.check(harness.call);
    await interceptor.check(harness.call);

    assert.equal(events.length, 2);
    assert.equal(events[0]?.cached, false);
    assert.equal(events[1]?.cached, true);
    assert.equal(events[1]?.ledger, 100);
  });

  it("fires once per waiter on a coalesced path", async () => {
    const events: PreFlightVerdictEvent[] = [];
    const interceptor = observedInterceptor(createMockServer({ simulateDelayMs: 10 }), events);

    const [first, second] = await Promise.all([
      interceptor.check(validTransferCall()),
      interceptor.check(validTransferCall()),
    ]);

    assert.equal(first.kind, "admissible");
    assert.equal(second.kind, "admissible");
    assert.equal(events.length, 2, "each returned verdict is reported exactly once");
    assert.deepEqual(
      events.map((event) => event.cached),
      [false, false],
    );
  });

  it("does not fire when input validation throws", async () => {
    const events: PreFlightVerdictEvent[] = [];
    const interceptor = observedInterceptor(createMockServer(), events);

    await assert.rejects(
      async () =>
        interceptor.check({ contract: unsafeContractAddress(""), fn: "transfer", args: [] }),
      InvalidInputError,
    );
    assert.equal(events.length, 0);
  });

  it("a throwing hook cannot change the verdict or its fee data", async () => {
    const interceptor = observedInterceptor(createMockServer(), [], {
      onVerdict: () => {
        throw new Error("observer exploded");
      },
    });

    const decision = await interceptor.check(validTransferCall());

    assert.equal(decision.kind, "admissible");
    assert.equal(decision.allowed, true);
    assert.ok(decision.kind === "admissible" && decision.estimatedResourceFee > 0n);
  });

  it("a rejected async hook is swallowed instead of becoming an unhandled rejection", async () => {
    const interceptor = new PreFlightInterceptor({
      server: createMockServer(),
      networkPassphrase: NETWORK_PASSPHRASE,
      guard: VALID_GUARD,
      agent: Keypair.random(),
      source: Keypair.random(),
      onVerdict: async () => {
        throw new Error("async observer exploded");
      },
    });

    const decision = await interceptor.check(validTransferCall());
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(decision.kind, "admissible");
  });
});

/* -------------------------------------------------------------------------- */

/**
 * Batch deadline (#407): `deadlineMs` is one absolute budget for the whole
 * batch, not a per-call value and not documentation-only. Time is advanced by
 * the mock server so the test never sleeps.
 */
describe("PreFlightInterceptor.checkBatch() deadline enforcement (#407)", () => {
  function deadlineServer(onSimulate: (clock: { advance: (ms: number) => void }) => void) {
    let simulations = 0;
    const clock = {
      now: 0,
      advance(ms: number) {
        this.now += ms;
      },
    };
    const server = {
      getAccount: async () => new Account(Keypair.random().publicKey(), "1"),
      getLatestLedger: async () => ({ sequence: 100 }),
      simulateTransaction: async () => {
        simulations += 1;
        onSimulate(clock);
        return {
          result: { auth: [] },
          minResourceFee: "10",
          transactionData: { getReadOnly: () => [], getReadWrite: () => [] },
        };
      },
    } as unknown as rpc.Server;
    return {
      server,
      clock: { now: () => clock.now, sleep: async (ms: number) => clock.advance(ms) },
      simulations: () => simulations,
    };
  }

  const batchOptions = { policy: null, initialWindowSpent: 0n };

  it("starts no further calls once the budget is spent and fails them closed", async () => {
    const harness = deadlineServer((clock) => clock.advance(40));
    const interceptor = new PreFlightInterceptor({
      server: harness.server,
      networkPassphrase: "Test SDF Network ; September 2015",
      guard: VALID_GUARD,
      agent: Keypair.random(),
      source: Keypair.random(),
      clock: harness.clock,
    });

    const decision = await interceptor.checkBatch(
      [validTransferCall(1n), validTransferCall(2n), validTransferCall(3n)],
      { ...batchOptions, deadlineMs: 100 },
    );

    // Call 1 finishes at 80ms (admissible); call 2 starts at 80 and lands at
    // 120 (after the deadline, so it is replaced); call 3 never starts.
    assert.equal(decision.admissible, false);
    assert.equal(decision.kind, "undetermined");
    assert.equal(decision.verdicts.length, 3);
    assert.equal(decision.verdicts[0]?.kind, "admissible", "completed verdicts keep their kind");
    for (const verdict of decision.verdicts.slice(1)) {
      assert.equal(verdict.kind, "undetermined");
      if (verdict.kind !== "undetermined") throw new Error("unreachable");
      assert.ok(verdict.error instanceof RpcTimeoutError);
      assert.equal(verdict.error.deadline, true);
    }
    assert.equal(harness.simulations(), 4, "the third call must issue no RPC");
  });

  it("never returns admissible when the last started call overruns the budget", async () => {
    const harness = deadlineServer((clock) => clock.advance(60));
    const interceptor = new PreFlightInterceptor({
      server: harness.server,
      networkPassphrase: "Test SDF Network ; September 2015",
      guard: VALID_GUARD,
      agent: Keypair.random(),
      source: Keypair.random(),
      clock: harness.clock,
    });

    const decision = await interceptor.checkBatch([validTransferCall()], {
      ...batchOptions,
      deadlineMs: 100,
    });

    assert.equal(decision.admissible, false);
    const verdict = decision.verdicts[0];
    assert.equal(verdict?.kind, "undetermined");
    if (verdict?.kind !== "undetermined") throw new Error("unreachable");
    assert.ok(verdict.error instanceof RpcTimeoutError);
    assert.equal(verdict.error.deadline, true);
  });
});

/* -------------------------------------------------------------------------- */

/**
 * Diagnostics-only simulation (#411): exposes the enforced pipeline without
 * producing a verdict, with redaction controlled by `includeRaw`.
 */
describe("PreFlightInterceptor.simulateForDiagnostics() (#411)", () => {
  function diagnosticsInterceptor(enforced: unknown) {
    let simulations = 0;
    const server = {
      getAccount: async () => new Account(Keypair.random().publicKey(), "1"),
      getLatestLedger: async () => ({ sequence: 100 }),
      simulateTransaction: async () => {
        simulations += 1;
        if (simulations % 2 === 0) return enforced;
        return {
          result: { auth: [] },
          minResourceFee: "10",
          transactionData: { getReadOnly: () => [], getReadWrite: () => [] },
        };
      },
    } as unknown as rpc.Server;
    return {
      interceptor: new PreFlightInterceptor({
        server,
        networkPassphrase: "Test SDF Network ; September 2015",
        guard: VALID_GUARD,
        agent: Keypair.random(),
        source: Keypair.random(),
      }),
      simulations: () => simulations,
    };
  }

  function blockedSimulation() {
    return {
      error: "blocked",
      events: [
        {
          event: {
            contractId: VALID_GUARD,
            body: {
              v0: {
                topics: [
                  xdr.ScVal.scvSymbol("event_auth_checked"),
                  xdr.ScVal.scvSymbol("blocked"),
                  xdr.ScVal.scvSymbol("per_tx_cap_exceeded"),
                ],
                data: xdr.ScVal.scvVoid(),
              },
            },
          },
        },
      ],
    };
  }

  it("returns no verdict, decodes the guard event and redacts raw payloads by default", async () => {
    const harness = diagnosticsInterceptor(blockedSimulation());

    const diagnostics = await harness.interceptor.simulateForDiagnostics(validTransferCall());

    assert.equal(diagnostics.authoritative, false);
    assert.equal("allowed" in diagnostics, false);
    assert.equal("admissible" in diagnostics, false);
    assert.equal(diagnostics.ok, false);
    assert.equal(diagnostics.guardEvent?.decision?.result, "blocked");
    assert.equal(diagnostics.guardEvent?.decision?.reason, "per_tx_cap_exceeded");
    assert.equal(diagnostics.events[0]?.raw, undefined, "raw payloads are redacted by default");
    // Both probe and enforced simulation ran; no broadcast path exists here.
    assert.equal(harness.simulations(), 2);
  });

  it("retains raw payloads when includeRaw is set", async () => {
    const harness = diagnosticsInterceptor(blockedSimulation());

    const diagnostics = await harness.interceptor.simulateForDiagnostics(validTransferCall(), {
      includeRaw: true,
    });

    assert.notEqual(diagnostics.events[0]?.raw, undefined);
  });

  it("reports a network failure as a typed error, not a verdict", async () => {
    const harness = diagnosticsInterceptor(blockedSimulation());
    // Make the probe fail before any decision can be reached.
    const failing = new PreFlightInterceptor({
      server: {
        getAccount: async () => {
          throw new Error("network down");
        },
      } as unknown as rpc.Server,
      networkPassphrase: "Test SDF Network ; September 2015",
      guard: VALID_GUARD,
      agent: Keypair.random(),
      source: Keypair.random(),
    });

    const diagnostics = await failing.simulateForDiagnostics(validTransferCall());

    assert.equal(diagnostics.authoritative, false);
    assert.equal(diagnostics.ok, false);
    assert.ok(diagnostics.error instanceof GuardError);
    assert.equal(diagnostics.guardEvent, null);
    assert.equal(harness.simulations(), 0);
  });

  it("bounds the run with timeoutMs and signs nothing for submission", async () => {
    let simulations = 0;
    const stalled = {
      getAccount: async () => new Account(Keypair.random().publicKey(), "1"),
      getLatestLedger: async () => ({ sequence: 100 }),
      simulateTransaction: async () => {
        simulations += 1;
        return new Promise(() => {});
      },
    } as unknown as rpc.Server;
    const interceptor = new PreFlightInterceptor({
      server: stalled,
      networkPassphrase: "Test SDF Network ; September 2015",
      guard: VALID_GUARD,
      agent: Keypair.random(),
      source: Keypair.random(),
    });

    const diagnostics = await interceptor.simulateForDiagnostics(validTransferCall(), {
      timeoutMs: 10,
    });

    assert.equal(diagnostics.authoritative, false);
    assert.equal(diagnostics.ok, false);
    assert.ok(diagnostics.error instanceof RpcTimeoutError);
    assert.equal(simulations, 1);
  });
});
