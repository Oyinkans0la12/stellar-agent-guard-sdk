/**
 * Unit tests for the guard event vocabulary.
 *
 * These pin the schema verified against the live chain in `docs/event-schema.md`
 * — in particular the `event_` prefix that the documentation omits, and the
 * empty-symbol reason on an allowed decision. Both were real defects, so they get
 * a regression test rather than a comment.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { xdr } from "@stellar/stellar-sdk";
import {
  GUARD_AUTH_RESULTS,
  GUARD_EVENT_TOPICS,
  decodeAuthDecision,
  decodeGuardEventXdr,
  normalizeU64,
  validateGuardEventXdr,
} from "../../src/events.ts";

/** Build the base64 `ContractEvent` XDR a block explorer hands over. */
function contractEventXdr(topics: string[]): string {
  return new xdr.ContractEvent({
    ext: xdr.ExtensionPoint.v0(),
    contractId: null,
    type: xdr.ContractEventType.contract,
    body: xdr.ContractEventBody.v0(
      new xdr.ContractEventV0({
        topics: topics.map((topic) => xdr.ScVal.scvSymbol(topic)),
        data: xdr.ScVal.scvVoid(),
      }),
    ),
  }).toXDR("base64");
}

/** The same event in the `DiagnosticEvent` wrapper a simulation error carries. */
function diagnosticEventXdr(topics: string[]): string {
  const event = xdr.ContractEvent.fromXDR(contractEventXdr(topics), "base64");
  return new xdr.DiagnosticEvent({ inSuccessfulContractCall: true, event }).toXDR("base64");
}

describe("guard event topics", () => {
  it("carries the event_ prefix the #[contractevent] macro adds", () => {
    assert.deepEqual(GUARD_EVENT_TOPICS, {
      authChecked: "event_auth_checked",
      heartbeat: "event_heartbeat",
      initialized: "event_initialized",
      frozen: "event_frozen",
      unfrozen: "event_unfrozen",
      policySet: "event_policy_set",
      policyRevoked: "event_policy_revoked",
    });
  });

  it("does not use the un-prefixed name the contracts SPEC documents", () => {
    assert.notEqual(GUARD_EVENT_TOPICS.authChecked, "auth_checked");
  });
});

describe("decodeAuthDecision", () => {
  it("decodes the captured allowed event", () => {
    // Verbatim from the live capture: allowed carries an empty reason symbol.
    const decision = decodeAuthDecision(["event_auth_checked", "allowed", ""], "ledger");
    assert.deepEqual(decision, { result: "allowed", reason: null, source: "ledger" });
  });

  it("decodes the captured blocked event", () => {
    const decision = decodeAuthDecision(
      ["event_auth_checked", "blocked", "per_tx_cap_exceeded"],
      "diagnostic",
    );
    assert.deepEqual(decision, {
      result: "blocked",
      reason: "per_tx_cap_exceeded",
      source: "diagnostic",
    });
  });

  it("normalises the empty reason symbol to null, never an empty string", () => {
    const decision = decodeAuthDecision(["event_auth_checked", "allowed", ""], "ledger");
    assert.equal(decision?.reason, null);
  });

  it("rejects the un-prefixed topic so docs drift cannot pass silently", () => {
    assert.equal(decodeAuthDecision(["auth_checked", "blocked", "paused"], "diagnostic"), null);
  });

  it("ignores a heartbeat, which is a separate event", () => {
    assert.equal(decodeAuthDecision(["event_heartbeat"], "ledger"), null);
  });

  it("ignores an empty topic list", () => {
    assert.equal(decodeAuthDecision([], "ledger"), null);
  });

  it("rejects an unknown result symbol", () => {
    assert.equal(decodeAuthDecision(["event_auth_checked", "maybe", "x"], "ledger"), null);
  });

  it("exposes the result vocabulary it matches on", () => {
    assert.deepEqual(GUARD_AUTH_RESULTS, { allowed: "allowed", blocked: "blocked" });
  });
});

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { scValToNative } from "@stellar/stellar-sdk";
import { topicSymbols } from "../../src/invoke.ts";
import { GUARD_REASON_CODES, explainReason } from "../../src/reasons.ts";
import { diagnosticsToEvents } from "../../src/telemetry.ts";

interface GoldenFixtureEntry {
  name: string;
  result: "allowed" | "blocked";
  reason: string;
  code: number | null;
  stream: "ledger" | "diagnostic";
  topics: string[];
  topicsXdr: string[];
}

interface ContractFixturesFile {
  _provenance: {
    sourceRepo: string;
    sourceCommit: string;
    sourceFile: string;
    refreshCommand: string;
    updatedAt: string;
    description: string;
  };
  entries: GoldenFixtureEntry[];
}

describe("differential test: SDK ScVal decoding vs contract fixture vocabulary", () => {
  const fixturePath = resolve(process.cwd(), "tests/fixtures/contract-fixtures.json");
  const rawData = readFileSync(fixturePath, "utf8");
  const fixture = JSON.parse(rawData) as ContractFixturesFile;

  it("verifies fixture provenance and hermetic vendoring", () => {
    assert.ok(fixture._provenance, "Fixture must include _provenance header");
    assert.equal(fixture._provenance.sourceRepo, "Stellar-Agent-Guard/stellar-agent-guard-contracts");
    assert.ok(fixture._provenance.sourceCommit.length >= 7, "Commit hash must be present");
    assert.equal(fixture._provenance.refreshCommand, "npm run sync:fixtures");
    assert.ok(Array.isArray(fixture.entries) && fixture.entries.length > 0, "Fixture entries must be non-empty");
  });

  for (const entry of fixture.entries) {
    it(`decodes golden fixture entry: ${entry.name}`, () => {
      // 1. Decode each golden topic from ScVal base64 XDR
      const decodedTopics = entry.topicsXdr.map((xdrBase64, idx) => {
        try {
          const scVal = xdr.ScVal.fromXDR(xdrBase64, "base64");
          return String(scValToNative(scVal));
        } catch (err) {
          assert.fail(`[${entry.name}] field 'topicsXdr[${idx}]' failed ScVal base64 decode: ${String(err)}`);
        }
      });

      // Verify decoded topic strings match expected topics
      assert.deepEqual(
        decodedTopics,
        entry.topics,
        `[${entry.name}] field 'topics' mismatch after ScVal decoding`,
      );

      // 2. Decode auth decision through decodeAuthDecision
      const decision = decodeAuthDecision(decodedTopics, entry.stream);
      assert.ok(decision !== null, `[${entry.name}] decodeAuthDecision returned null`);

      // 3. Differential assertions per field
      assert.equal(
        decision.result,
        entry.result,
        `[${entry.name}] field 'result' mismatch: expected ${entry.result}, got ${decision.result}`,
      );

      assert.equal(
        decision.source,
        entry.stream,
        `[${entry.name}] field 'source' mismatch: expected ${entry.stream}, got ${decision.source}`,
      );

      if (entry.result === "allowed") {
        assert.equal(
          decision.reason,
          null,
          `[${entry.name}] field 'reason' mismatch: allowed decision must normalise reason to null`,
        );
      } else {
        assert.equal(
          decision.reason,
          entry.reason,
          `[${entry.name}] field 'reason' mismatch: expected ${entry.reason}, got ${decision.reason}`,
        );

        // Numeric code match in reason table
        const expectedCode = GUARD_REASON_CODES[entry.reason as keyof typeof GUARD_REASON_CODES];
        assert.equal(
          expectedCode,
          entry.code,
          `[${entry.name}] field 'code' mismatch in GUARD_REASON_CODES: expected ${entry.code}, got ${expectedCode}`,
        );

        // Explanation must be non-empty and known
        const explanation = explainReason(entry.reason);
        assert.ok(
          explanation && explanation.length > 0,
          `[${entry.name}] field 'explanation' was empty for reason ${entry.reason}`,
        );
        assert.ok(
          !explanation.includes("Unrecognised"),
          `[${entry.name}] field 'explanation' triggered fallback for reason ${entry.reason}`,
        );

        // 4. Verify canonical diagnostic decode path (topicSymbols -> diagnosticsToEvents)
        const mockRawDiagnosticEvent = {
          event: {
            body: {
              v0: {
                topics: entry.topicsXdr,
              },
            },
          },
        };

        const extractedSymbols = topicSymbols(mockRawDiagnosticEvent.event);
        assert.deepEqual(
          extractedSymbols,
          entry.topics,
          `[${entry.name}] field 'topicSymbols' mismatch on raw diagnostic event`,
        );

        const guardEvents = diagnosticsToEvents([mockRawDiagnosticEvent]);
        assert.equal(
          guardEvents.length,
          1,
          `[${entry.name}] diagnosticsToEvents should produce 1 GuardEvent`,
        );
        assert.equal(
          guardEvents[0]?.kind,
          "auth_checked",
          `[${entry.name}] GuardEvent kind mismatch`,
        );
        assert.equal(
          guardEvents[0]?.decision?.result,
          "blocked",
          `[${entry.name}] GuardEvent decision result mismatch`,
        );
        assert.equal(
          guardEvents[0]?.decision?.reason,
          entry.reason,
          `[${entry.name}] GuardEvent decision reason mismatch`,
        );
      }
    });
  }
});

describe("normalizeU64", () => {
  
  it("normalizes a string of digits to a bigint", () => {
    assert.equal(normalizeU64("1789393232"), 1789393232n);
  });
  
  it("never loses precision for >2^53", () => {
    const large = "9007199254740993"; // Number.MAX_SAFE_INTEGER + 2
    assert.equal(normalizeU64(large), 9007199254740993n);
  });

  it("preserves non-digit strings", () => {
    assert.equal(normalizeU64("2023-11-20T12:00:00Z"), "2023-11-20T12:00:00Z");
  });
});

describe("decodeGuardEventXdr", () => {
  it("returns null for empty string input", () => {
    assert.equal(decodeGuardEventXdr(""), null);
  });

  it("returns null for invalid base64 without throwing", () => {
    assert.equal(decodeGuardEventXdr("!!!not-base64!!!"), null);
  });

  it("returns null for an XDR payload that is not a contract event", () => {
    const notAnEvent = xdr.ScVal.scvU32(1234).toXDR("base64");
    assert.equal(decodeGuardEventXdr(notAnEvent), null);
  });

  it("decodes the allowed event and normalises the empty reason symbol", () => {
    const decision = decodeGuardEventXdr(
      contractEventXdr([GUARD_EVENT_TOPICS.authChecked, GUARD_AUTH_RESULTS.allowed, ""]),
    );
    assert.deepEqual(decision, { result: "allowed", reason: null, source: "diagnostic" });
  });

  it("decodes a blocked event and keeps its reason", () => {
    const decision = decodeGuardEventXdr(
      contractEventXdr([GUARD_EVENT_TOPICS.authChecked, GUARD_AUTH_RESULTS.blocked, "per_tx_cap_exceeded"]),
    );
    assert.deepEqual(decision, {
      result: "blocked",
      reason: "per_tx_cap_exceeded",
      source: "diagnostic",
    });
  });

  it("accepts the DiagnosticEvent wrapper a simulation error carries", () => {
    const topics = [GUARD_EVENT_TOPICS.authChecked, GUARD_AUTH_RESULTS.blocked, "paused"];
    assert.deepEqual(decodeGuardEventXdr(diagnosticEventXdr(topics)), decodeGuardEventXdr(contractEventXdr(topics)));
  });

  it("honours an explicit source for a ledger-read payload", () => {
    const decision = decodeGuardEventXdr(
      contractEventXdr([GUARD_EVENT_TOPICS.authChecked, GUARD_AUTH_RESULTS.allowed, ""]),
      "ledger",
    );
    assert.equal(decision?.source, "ledger");
  });

  it("rejects a non-decision event such as a heartbeat", () => {
    assert.equal(decodeGuardEventXdr(contractEventXdr([GUARD_EVENT_TOPICS.heartbeat])), null);
  });

  it("rejects the un-prefixed topic the docs use, so docs drift cannot pass", () => {
    assert.equal(decodeGuardEventXdr(contractEventXdr(["auth_checked", "blocked", "paused"])), null);
  });

  it("agrees with the object-path decode for the same event", () => {
    const topics = [GUARD_EVENT_TOPICS.authChecked, GUARD_AUTH_RESULTS.blocked, "window_cap_exceeded"];
    assert.deepEqual(decodeGuardEventXdr(contractEventXdr(topics)), decodeAuthDecision(topics, "diagnostic"));
  });
});


describe("validateGuardEventXdr (strict offline validation)", () => {
  it("reports malformed XDR and unknown topics by input index and stage, keeping valid neighbours", () => {
    const allowed = contractEventXdr([
      GUARD_EVENT_TOPICS.authChecked,
      GUARD_AUTH_RESULTS.allowed,
      "",
    ]);
    const blocked = contractEventXdr([
      GUARD_EVENT_TOPICS.authChecked,
      GUARD_AUTH_RESULTS.blocked,
      "paused",
    ]);
    const unknownTopic = contractEventXdr(["fn_call", "transfer"]);

    const report = validateGuardEventXdr([allowed, "!!!not-base64!!!", unknownTopic, blocked]);

    assert.equal(report.ok, false, "any rejected input makes the report fail");
    assert.deepEqual(
      report.results.map((result) => [result.index, result.ok, result.ok ? null : result.stage]),
      [
        [0, true, null],
        [1, false, "xdr"],
        [2, false, "decision"],
        [3, true, null],
      ],
      "every input is accounted for, in input order",
    );
    assert.deepEqual(
      report.failures.map((failure) => ({
        index: failure.index,
        path: failure.path,
        stage: failure.stage,
        code: failure.code,
      })),
      [
        { index: 1, path: "events[1]", stage: "xdr", code: "xdr.unparseable" },
        {
          index: 2,
          path: "events[2].topics[0]",
          stage: "decision",
          code: "decision.unknown_topic",
        },
      ],
      "failure paths are stable and identify the exact event and field",
    );
    assert.deepEqual(report.events, [
      { result: "allowed", reason: null, source: "diagnostic" },
      { result: "blocked", reason: "paused", source: "diagnostic" },
    ]);
  });

  it("reports an invalid decision result at the result-topic path", () => {
    const invalid = contractEventXdr([
      GUARD_EVENT_TOPICS.authChecked,
      "maybe",
      "paused",
    ]);

    const report = validateGuardEventXdr([invalid]);

    assert.equal(report.ok, false);
    assert.deepEqual(report.failures, [
      {
        index: 0,
        path: "events[0].topics[1]",
        stage: "decision",
        code: "decision.invalid_result",
        message: report.failures[0]!.message,
      },
    ]);
  });

  it("applies the requested source and path without changing the live decoder", () => {
    const payload = contractEventXdr([
      GUARD_EVENT_TOPICS.authChecked,
      GUARD_AUTH_RESULTS.allowed,
      "",
    ]);

    const report = validateGuardEventXdr([payload], { source: "ledger", path: "fixtures" });

    assert.equal(report.ok, true);
    assert.deepEqual(report.events, [{ result: "allowed", reason: null, source: "ledger" }]);
    assert.equal(report.results[0]?.path, "fixtures[0]");
    assert.deepEqual(decodeGuardEventXdr(payload), {
      result: "allowed",
      reason: null,
      source: "diagnostic",
    });
  });

  it("rejects non-string and empty inputs at the input stage", () => {
    const report = validateGuardEventXdr([null, "", 42]);

    assert.deepEqual(
      report.failures.map((failure) => [failure.index, failure.stage, failure.code]),
      [
        [0, "input", "input.not_string"],
        [1, "input", "input.empty"],
        [2, "input", "input.not_string"],
      ],
    );
    assert.equal(report.ok, false);
  });

  it("returns a stable report when the same fixture is validated twice", () => {
    const valid = contractEventXdr([
      GUARD_EVENT_TOPICS.authChecked,
      GUARD_AUTH_RESULTS.blocked,
      "paused",
    ]);

    assert.deepEqual(
      validateGuardEventXdr([valid, "broken"]),
      validateGuardEventXdr([valid, "broken"]),
    );
  });
});
