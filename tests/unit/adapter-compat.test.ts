/**
 * Framework-version compatibility smoke fixtures (issue #319).
 *
 * The adapters are structural — this package has no framework runtime
 * dependencies — so a type-compatible shape is not enough evidence: each
 * fixture drives the *actual continuation* the framework calls, with a tool
 * body that increments a counter. The assertion that matters is that a block
 * leaves that counter at zero, which proves the exercised hook is
 * pre-execution and not merely shaped like one.
 *
 * Each framework shape is pinned to the source revision recorded in
 * `docs/integration-hooks.md` (or to the published major line where the
 * framework publishes no blob pin). The last test keeps that document and
 * these fixtures in sync, so a pin bump has one place to change and evidence
 * cannot silently drift.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";
import { guardAction } from "../../src/adapters/elizaos.ts";
import { createLangChainGuardMiddleware } from "../../src/adapters/langchain.ts";
import {
  guardMcpCallTool,
  guardMcpToolHandler,
  type McpToolResult,
} from "../../src/adapters/mcp.ts";
import { createVercelAIGuard } from "../../src/adapters/vercelai.ts";
import { unsafeContractAddress } from "../../src/policy.ts";
import type { PreFlightDecision, PreFlightInterceptor } from "../../src/preflight.ts";
import type { ContractCall } from "../../src/tx.ts";

const GUARD = unsafeContractAddress("CAPADGEK457RHKN4RYVUMDJTFHDSG7R5HREQONKLYK7MFKC5WFENPP44");

const CALL: ContractCall = { contract: GUARD, fn: "transfer", args: [] };

const BLOCKED: PreFlightDecision = {
  allowed: false,
  kind: "blocked",
  reason: "per_tx_cap_exceeded",
  explanation: "per-transaction cap exceeded",
  detail: "enforced simulation refused the transfer",
  diagnosticEvents: [],
};

const ALLOWED: PreFlightDecision = {
  allowed: true,
  kind: "admissible",
  estimatedResourceFee: 100n,
  footprintKeys: 2,
};

function stub(decision: PreFlightDecision): PreFlightInterceptor {
  return { check: async () => decision } as unknown as PreFlightInterceptor;
}

/**
 * Pins exercised by these fixtures. Keep in step with the "Compatibility smoke
 * fixtures" table in `docs/integration-hooks.md`; the sync test below fails if
 * a pin is dropped from the document.
 */
const COMPATIBILITY_PINS = {
  langchain: "b7d5b8050ab887acb3f180edae17ee06c11022d2",
  elizaos: "c13af759cafde630483450f97bb802b58d1b253a",
  mcpV1: "2d2f19ae376bee6081437c4d6f8e251bf3fd3ce5",
  mcpV2: "6d5e2328efd2fc4493731b4e4cfd2e117ad1e28d",
  vercelai: "ai 5.x `Tool.execute`",
} as const;

describe("pinned framework revisions (issue #319)", () => {
  it("records every exercised pin in docs/integration-hooks.md", () => {
    const doc = readFileSync(resolve(process.cwd(), "docs/integration-hooks.md"), "utf8");
    for (const [framework, pin] of Object.entries(COMPATIBILITY_PINS)) {
      assert.ok(doc.includes(pin), `${framework} pin "${pin}" is missing from docs/integration-hooks.md`);
    }
  });
});

describe("LangChain hook shape — AgentMiddleware.wrapToolCall", () => {
  const request = { toolCall: { name: "send_payment", args: { amount: "10" }, id: "call_1" } };

  it("never enters the tool body when the guard blocks", async () => {
    let entered = 0;
    const middleware = createLangChainGuardMiddleware({
      interceptor: stub(BLOCKED),
      toContractCall: () => CALL,
    });

    const result = await middleware.wrapToolCall(request, async () => {
      entered += 1;
      return "sent";
    });

    assert.equal(entered, 0, "wrapToolCall's continuation is the tool body: a block must not call it");
    assert.equal((result as { status?: string }).status, "error");
  });

  it("runs the continuation unchanged when the guard allows", async () => {
    let entered = 0;
    const middleware = createLangChainGuardMiddleware({
      interceptor: stub(ALLOWED),
      toContractCall: () => CALL,
    });

    const result = await middleware.wrapToolCall(request, async () => {
      entered += 1;
      return "sent";
    });

    assert.equal(entered, 1);
    assert.equal(result, "sent");
  });
});

describe("ElizaOS hook shape — Action.validate gate", () => {
  it("drops the action before its handler runs when the guard blocks", async () => {
    let entered = 0;
    const action = guardAction(
      {
        name: "send_payment",
        validate: async () => true,
        handler: async () => {
          entered += 1;
        },
      },
      { interceptor: stub(BLOCKED), toContractCall: () => CALL },
    );

    // The runtime only invokes handlers for actions whose validate() was truthy.
    const eligible = (await action.validate({}, {}, {}, {})) ? [action] : [];
    for (const admitted of eligible) await admitted.handler();

    assert.equal(entered, 0);
    assert.deepEqual(eligible, []);
  });

  it("admits the action and runs its handler when the guard allows", async () => {
    let entered = 0;
    const action = guardAction(
      {
        name: "send_payment",
        validate: async () => true,
        handler: async () => {
          entered += 1;
        },
      },
      { interceptor: stub(ALLOWED), toContractCall: () => CALL },
    );

    const eligible = (await action.validate({}, {}, {}, {})) ? [action] : [];
    for (const admitted of eligible) await admitted.handler();

    assert.equal(entered, 1);
    assert.equal(eligible.length, 1);
  });
});

describe("MCP hook shapes — registered handler and client callTool", () => {
  it("a v2 registerTool handler returns an error result without entering the tool body", async () => {
    let entered = 0;
    const wrapped = guardMcpToolHandler(
      "send_payment",
      async () => {
        entered += 1;
        return { content: [{ type: "text", text: "sent" }] };
      },
      { interceptor: stub(BLOCKED), toContractCall: () => CALL },
    );

    // What `server.registerTool(name, config, handler)` would store and invoke.
    const registered = { send_payment: wrapped };
    const result = await registered.send_payment!({ amount: "10" }, {});

    assert.equal(entered, 0);
    assert.equal((result as McpToolResult).isError, true);
  });

  it("a v1 client callTool wrapper refuses before the request leaves the process", async () => {
    let sent = 0;
    const callTool = guardMcpCallTool(
      async () => {
        sent += 1;
        return { content: [{ type: "text", text: "sent" }] };
      },
      { interceptor: stub(BLOCKED), toContractCall: () => CALL },
    );

    const result = await callTool({ name: "send_payment", arguments: {} });
    assert.equal(sent, 0);
    assert.equal((result as McpToolResult).isError, true);
  });
});

describe("Vercel AI hook shape — tool execute", () => {
  it("throws before execute is entered when the guard blocks", async () => {
    let entered = 0;
    const guard = createVercelAIGuard({
      interceptor: stub(BLOCKED),
      toContractCall: () => CALL,
    });
    const tool = guard("send_payment", {
      execute: async () => {
        entered += 1;
        return "sent";
      },
    });

    await assert.rejects(tool.execute!());
    assert.equal(entered, 0, "the wrapped execute is the earliest pre-execution point");
  });

  it("runs the wrapped execute when the guard allows", async () => {
    let entered = 0;
    const guard = createVercelAIGuard({
      interceptor: stub(ALLOWED),
      toContractCall: () => CALL,
    });
    const tool = guard("send_payment", {
      execute: async () => {
        entered += 1;
        return "sent";
      },
    });

    assert.equal(await tool.execute!(), "sent");
    assert.equal(entered, 1);
  });
});
