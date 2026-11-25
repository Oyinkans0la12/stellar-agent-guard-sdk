/**
 * Truth table for every guard reason: no reason code may ever decode as
 * `admissible` (issue #406).
 *
 * The rows come from the vendored contracts fixture, and the table is checked
 * bidirectionally against `GUARD_REASON_CODES`, so adding a reason upstream
 * without teaching the verdict path about it fails here rather than shipping.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import { resolve } from "node:path";
import { xdr } from "@stellar/stellar-sdk";
import { decodeCheckResult } from "../../src/policy.ts";
import { GUARD_REASON_CODES, type GuardReason } from "../../src/reasons.ts";

interface ReasonsFixture {
  reasonGlossary: {
    reasons: Record<string, { code: number }>;
  };
}

const fixture = JSON.parse(
  await readFile(resolve(process.cwd(), "tests/fixtures/vendor/reasons.fixture.json"), "utf8"),
) as ReasonsFixture;
const fixtureReasons = fixture.reasonGlossary.reasons;

describe("every guard reason decodes to blocked, never admissible", () => {
  const codeEntries = Object.entries(GUARD_REASON_CODES) as Array<[GuardReason, number]>;

  it("the fixture and GUARD_REASON_CODES list the same reasons and codes", () => {
    const fixtureNames = Object.keys(fixtureReasons).sort();
    const sdkNames = codeEntries.map(([reason]) => reason).sort();
    assert.deepEqual(fixtureNames, sdkNames);

    for (const [reason, code] of codeEntries) {
      assert.equal(fixtureReasons[reason]?.code, code, `numeric code mismatch for ${reason}`);
    }
  });

  for (const [reason, code] of codeEntries) {
    it(`${reason} (code ${code}) decodes to blocked with that exact reason`, () => {
      const expected = { kind: "blocked", reason };
      // Native `{ Blocked: reason }` form, the raw ScVec enum form the contract
      // returns, and the `{ Blocked: reason }` object form all agree.
      assert.deepEqual(decodeCheckResult({ Blocked: reason }), expected);
      assert.deepEqual(
        decodeCheckResult(
          xdr.ScVal.scvVec([xdr.ScVal.scvSymbol("Blocked"), xdr.ScVal.scvSymbol(reason)]),
        ),
        expected,
      );
      assert.notEqual(decodeCheckResult({ Blocked: reason }).kind, "allowed");
    });
  }

  it("account-state reasons are covered explicitly", () => {
    // Paused, frozen by an admin, and frozen by the dead-man switch.
    for (const reason of ["paused", "admin_frozen", "heartbeat_expired"] as const) {
      assert.deepEqual(decodeCheckResult({ Blocked: reason }), { kind: "blocked", reason });
    }
  });

  it("policy reasons are covered explicitly", () => {
    for (const reason of [
      "per_tx_cap_exceeded",
      "window_cap_exceeded",
      "asset_not_allowed",
      "recipient_not_allowed",
      "protocol_not_allowed",
      "function_not_allowed",
    ] as const) {
      assert.deepEqual(decodeCheckResult({ Blocked: reason }), { kind: "blocked", reason });
    }
  });

  it("an allowed result yields admissible, and unknown reasons fail closed", () => {
    assert.deepEqual(decodeCheckResult("Allowed"), { kind: "allowed" });
    assert.deepEqual(decodeCheckResult(xdr.ScVal.scvVec([xdr.ScVal.scvSymbol("Allowed")])), {
      kind: "allowed",
    });
    assert.deepEqual(decodeCheckResult({ Blocked: "future_reason" }), { kind: "undetermined" });
  });
});
