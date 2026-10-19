/**
 * Unit tests for the Vercel AI SDK adapter (issue #44).
 *
 * The host hook is the tool's own `execute` function — the earliest point the
 * AI SDK owns where nothing has run yet. These tests drive the adapter through a
 * structural `Tool`-shaped stub, so no `ai` package install is needed and the
 * adapter's contract is pinned independently of the framework's version churn.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { GuardBlockedError } from "../../src/reasons.ts";
import { InvalidInputError, PreFlightUndeterminedError } from "../../src/preflight.ts";
import { unsafeContractAddress } from "../../src/policy.ts";
import { createVercelAIGuard, wrapToolWithGuard } from "../../src/adapters/vercelai.ts";
import type { PreFlightDecision, PreFlightInterceptor } from "../../src/preflight.ts";
import type { ContractCall } from "../../src/tx.ts";
import type { VercelAIToolLike } from "../../src/adapters/vercelai.ts";

const CALL: ContractCall = { contract: unsafeContractAddress("C".repeat(56)), fn: "transfer", args: [] };

/** An interceptor stub whose verdicts are queued per check. */
function stubInterceptor(verdicts: PreFlightDecision[]): PreFlightInterceptor {
  let i = 0;
  return {
    check: async () => {
      const decision = verdicts[Math.min(i, verdicts.length - 1)]!;
      i += 1;
      return decision;
    },
  } as unknown as PreFlightInterceptor;
}

function guardedTool(options: {
  interceptor: PreFlightInterceptor;
  toContractCall?: (call: { toolName: string; input: unknown }) => ContractCall | null;
  execute?: (input: never, options: unknown) => Promise<unknown>;
}): { entered: () => number; tool: VercelAIToolLike } {
  let entered = 0;
  const guard = createVercelAIGuard({
    interceptor: options.interceptor,
    toContractCall: options.toContractCall ?? (() => CALL),
  });
  const tool = guard(
    "send_payment",
    options.execute
      ? { execute: options.execute }
      : {
          execute: async () => {
            entered += 1;
            return "ran";
          },
        },
  );
  return { entered: () => entered, tool };
}

describe("createVercelAIGuard", () => {
  it("runs the wrapped execute when the verdict is admissible", async () => {
    const { entered, tool } = guardedTool({
      interceptor: stubInterceptor([
        { allowed: true, kind: "admissible", estimatedResourceFee: 1n, footprintKeys: 2 },
      ]),
    });

    const result = await (tool.execute as (input: never) => Promise<unknown>)(null as never);
    assert.equal(result, "ran");
    assert.equal(entered(), 1, "an admissible verdict must enter the tool body");
  });

  it("throws GuardBlockedError before execute runs when blocked", async () => {
    const { entered, tool } = guardedTool({
      interceptor: stubInterceptor([
        {
          allowed: false,
          kind: "blocked",
          reason: "recipient_not_allowed",
          explanation: "recipient not allowlisted",
          detail: "d",
          diagnosticEvents: [{ event: "diag" }],
        },
      ]),
    });

    await assert.rejects(
      () => (tool.execute as (input: never) => Promise<unknown>)(null as never),
      (error: unknown) => {
        assert.ok(error instanceof GuardBlockedError);
        assert.equal(error.reason, "recipient_not_allowed");
        assert.equal(error.stage, "preflight");
        assert.equal(error.charged, false);
        return true;
      },
    );
    assert.equal(entered(), 0, "the tool body ran despite a guard refusal");
  });

  it("throws PreFlightUndeterminedError and fails closed when undetermined", async () => {
    const { entered, tool } = guardedTool({
      interceptor: stubInterceptor([
        { allowed: false, kind: "undetermined", detail: "rpc unreachable" },
      ]),
    });

    await assert.rejects(
      () => (tool.execute as (input: never) => Promise<unknown>)(null as never),
      (error: unknown) => {
        assert.ok(error instanceof PreFlightUndeterminedError);
        assert.ok(error instanceof Error);
        assert.match(error.message, /could not determine/);
        return true;
      },
    );
    assert.equal(entered(), 0, "an undetermined verdict must not run the tool");
  });

  it("passes a non-fund-moving tool straight through without a check", async () => {
    let checks = 0;
    const interceptor = stubInterceptor([
      { allowed: true, kind: "admissible", estimatedResourceFee: 1n, footprintKeys: 2 },
    ]);
    const spied = {
      check: async (call: ContractCall) => {
        checks += 1;
        return interceptor.check(call);
      },
    } as unknown as PreFlightInterceptor;
    const { entered, tool } = guardedTool({ interceptor: spied, toContractCall: () => null });

    const result = await (tool.execute as (input: never) => Promise<unknown>)(null as never);
    assert.equal(result, "ran");
    assert.equal(entered(), 1);
    assert.equal(checks, 0, "a tool that moves no funds must not be intercepted");
  });

  it("returns a tool without execute untouched", () => {
    const guard = createVercelAIGuard({
      interceptor: stubInterceptor([]),
      toContractCall: () => CALL,
    });
    const tool: VercelAIToolLike = { description: "no execute" } as VercelAIToolLike;
    assert.equal(guard("weather", tool), tool);
  });

  it("forwards the tool input to toContractCall", async () => {
    let seenInput: unknown;
    const { tool } = guardedTool({
      interceptor: stubInterceptor([
        { allowed: true, kind: "admissible", estimatedResourceFee: 1n, footprintKeys: 2 },
      ]),
      toContractCall: (call) => {
        seenInput = call.input;
        return CALL;
      },
    });
    await (tool.execute as (input: unknown) => Promise<unknown>)({ to: "GABC", amount: 5 });
    assert.deepEqual(seenInput, { to: "GABC", amount: 5 });
  });

  it("reports every decision to onDecision", async () => {
    const decisions: PreFlightDecision[] = [
      { allowed: true, kind: "admissible", estimatedResourceFee: 1n, footprintKeys: 2 },
      {
        allowed: false,
        kind: "blocked",
        reason: "paused",
        explanation: "paused",
        detail: "d",
        diagnosticEvents: [],
      },
    ];
    const seen: PreFlightDecision[] = [];
    const guard = createVercelAIGuard({
      interceptor: stubInterceptor(decisions),
      toContractCall: () => CALL,
      onDecision: (_call, decision) => seen.push(decision),
    });
    const tool = guard("send_payment", { execute: async () => "ran" });
    await (tool.execute as (input: never) => Promise<unknown>)(null as never);
    await assert.rejects(() =>
      (tool.execute as (input: never) => Promise<unknown>)(null as never),
    );
    assert.deepEqual(seen, decisions);
  });
});

describe("wrapToolWithGuard", () => {
  it("binds the original execute and preserves the other tool fields", async () => {
    const seenThis: unknown[] = [];
    const original = {
      description: "payment tool",
      execute: async function (this: unknown, _input: never, _options: unknown) {
        seenThis.push(this);
        return "ok";
      },
    };
    const wrapped = wrapToolWithGuard(
      original,
      { interceptor: stubInterceptor([{ allowed: true, kind: "admissible", estimatedResourceFee: 1n, footprintKeys: 2 }]), toContractCall: () => CALL },
      { toolName: "send_payment", input: undefined },
    );
    assert.equal(wrapped.description, "payment tool");
    assert.equal(await wrapped.execute!(undefined as never, {}), "ok");
    assert.equal(seenThis.length, 1);
  });

  it("keeps adapter input validation errors as the interceptor's own", async () => {
    const throwing = {
      check: async () => {
        throw new InvalidInputError("contract", "valid-strkey", "bad call");
      },
    } as unknown as PreFlightInterceptor;
    const tool = wrapToolWithGuard(
      { execute: async () => "ran" },
      { interceptor: throwing, toContractCall: () => CALL },
      { toolName: "send_payment", input: undefined },
    );
    await assert.rejects(
      () => (tool.execute as (input: never) => Promise<unknown>)(null as never),
      InvalidInputError,
    );
  });
});

describe("Vercel AI SDK ordered call batch (issue #318)", () => {
  const BLOCKED: PreFlightDecision = {
    allowed: false,
    kind: "blocked",
    reason: "per_tx_cap_exceeded",
    explanation: "per-transaction cap exceeded",
    detail: "stub",
    diagnosticEvents: [],
  };
  const ADMISSIBLE: PreFlightDecision = {
    allowed: true,
    kind: "admissible",
    estimatedResourceFee: 1n,
    footprintKeys: 1,
  };

  function batchInterceptor(verdicts: PreFlightDecision[]): PreFlightInterceptor {
    return {
      check: async () => {
        throw new Error("single-call check must not run for a batch mapping");
      },
      checkBatch: async () => ({
        admissible: verdicts.every((verdict) => verdict.allowed),
        overallAdmissible: verdicts.every((verdict) => verdict.allowed),
        verdicts,
        calls: verdicts,
        totalEstimatedResourceFee: 0n,
      }),
    } as unknown as PreFlightInterceptor;
  }

  it("checks the whole batch first and does not execute when a later call is blocked", async () => {
    const seen: PreFlightDecision[] = [];
    let entered = 0;
    const guard = createVercelAIGuard({
      interceptor: batchInterceptor([ADMISSIBLE, BLOCKED]),
      toContractCalls: () => [CALL, { ...CALL, fn: "transfer_from" }],
      onDecision: (_call, decision) => seen.push(decision),
    });
    const tool = guard("batch_transfer", {
      execute: async () => {
        entered += 1;
        return "ran";
      },
    });

    await assert.rejects(
      () => (tool.execute as (input: never) => Promise<unknown>)(null as never),
      GuardBlockedError,
    );
    assert.equal(entered, 0);
    assert.deepEqual(
      seen.map((decision) => decision.kind),
      ["admissible", "blocked"],
    );
  });
});
