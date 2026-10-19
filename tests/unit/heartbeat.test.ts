/**
 * Unit tests for the heartbeat scheduler (issue #120).
 *
 * Time is injected (`now` / `wait`), never the wall clock: the scheduler is
 * driven by a controllable fake so "three beats" is exact rather than flaky.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Keypair } from "@stellar/stellar-sdk";
import {
  HeartbeatBlockedError,
  HeartbeatIntervalError,
  isRetryableHeartbeatFailure,
  startHeartbeat,
  type HeartbeatBeat,
  type HeartbeatOptions,
} from "../../src/heartbeat.ts";
import { BroadcastError, SimulationError } from "../../src/errors.ts";
import { RpcTimeoutError, type InvokeOutcome } from "../../src/invoke.ts";
import { GuardBlockedError } from "../../src/reasons.ts";
import type { PolicyConfig } from "../../src/policy.ts";

const GUARD = "CAPADGEK457RHKN4RYVUMDJTFHDSG7R5HREQONKLYK7MFKC5WFENPP44";

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * A deterministic clock. `wait` registers a deadline; `tick` resolves the
 * earliest pending wait, advancing time to its deadline. It honours the abort
 * signal so a mid-wait `stop()` wakes the loop instead of deadlocking it.
 */
function fakeClock() {
  let t = 0;
  const waiters: Array<{ deadline: number; resolve: () => void }> = [];
  const now = () => t;
  const wait = (ms: number, signal?: AbortSignal): Promise<void> =>
    new Promise((resolve) => {
      if (signal?.aborted) {
        resolve();
        return;
      }
      const entry = {
        deadline: t + Math.max(0, ms),
        resolve: () => {
          signal?.removeEventListener("abort", onAbort);
          resolve();
        },
      };
      const onAbort = () => {
        const i = waiters.indexOf(entry);
        if (i >= 0) waiters.splice(i, 1);
        resolve();
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      waiters.push(entry);
    });
  return {
    now,
    wait,
    get time() {
      return t;
    },
    get pending() {
      return waiters.length;
    },
    advanceTo(value: number) {
      t = value;
    },
    /** Resolve the earliest pending wait, advancing time to its deadline. */
    async tick(): Promise<void> {
      if (waiters.length === 0) {
        await flush();
        return;
      }
      waiters.sort((a, b) => a.deadline - b.deadline);
      const next = waiters.shift()!;
      t = Math.max(t, next.deadline);
      next.resolve();
      await flush();
    },
  };
}

function baseOptions(overrides: Partial<HeartbeatOptions> = {}): HeartbeatOptions {
  const clock = fakeClock();
  return {
    guard: GUARD,
    signer: Keypair.random(),
    intervalMs: 1000,
    now: clock.now,
    wait: clock.wait,
    submit: async () => ({}),
    ...overrides,
  };
}

describe("startHeartbeat", () => {
  it("fires three beats deterministically on the injected clock", async () => {
    const clock = fakeClock();
    const beats: HeartbeatBeat[] = [];
    let submissions = 0;

    const handle = await startHeartbeat(
      baseOptions({
        now: clock.now,
        wait: clock.wait,
        submit: async () => {
          submissions += 1;
          return {};
        },
        onBeat: (beat) => beats.push(beat),
      }),
    );

    assert.equal(submissions, 0, "nothing beats before the loop is driven");
    await clock.tick();
    assert.equal(submissions, 1, "the first beat fires immediately");
    await clock.tick();
    assert.equal(submissions, 2);
    await clock.tick();
    assert.equal(submissions, 3);

    assert.deepEqual(
      beats.map((beat) => beat.at),
      [0, 1000, 2000],
    );
    assert.equal(handle.lastBeatAt, 2000);
    await handle.stop();
  });

  it("stops cleanly and never submits after stop(), even mid-flight", async () => {
    const clock = fakeClock();
    let submissions = 0;
    let release: (() => void) | null = null;

    const handle = await startHeartbeat(
      baseOptions({
        now: clock.now,
        wait: clock.wait,
        submit: () => {
          submissions += 1;
          return new Promise<void>((resolve) => {
            release = resolve;
          });
        },
      }),
    );

    await clock.tick(); // first beat starts and stays in flight
    assert.equal(submissions, 1);

    const stopping = handle.stop(); // stop arrives while the beat is in flight
    release!();
    await stopping;

    assert.equal(handle.stopped, true);
    assert.equal(submissions, 1, "no submission may follow stop()");

    // Even if time keeps moving, the loop is gone.
    await clock.tick();
    await clock.tick();
    assert.equal(submissions, 1);
  });

  it("is stopped immediately when the abort signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const handle = await startHeartbeat(baseOptions({ signal: controller.signal }));
    assert.equal(handle.stopped, true);
    assert.equal(handle.lastBeatAt, null);
    await handle.stop();
  });

  it("stops when the abort signal fires", async () => {
    const controller = new AbortController();
    let submissions = 0;
    await startHeartbeat(
      baseOptions({
        signal: controller.signal,
        submit: async () => {
          submissions += 1;
          return {};
        },
      }),
    );
    controller.abort();
    await flush();
    await flush();
    const before = submissions;
    await flush();
    assert.equal(submissions, before, "no beats after abort");
  });

  it("counts and reports lateness beyond maxSkewMs", async () => {
    const clock = fakeClock();
    const beats: HeartbeatBeat[] = [];

    const handle = await startHeartbeat(
      baseOptions({
        now: clock.now,
        wait: clock.wait,
        maxSkewMs: 100,
        onBeat: (beat) => beats.push(beat),
      }),
    );

    await clock.tick(); // first beat on time (deadline 0)
    assert.equal(beats[0]!.lateMs, 0);
    assert.equal(handle.missedBeats, 0);

    // The second beat is due at t=1000, but the clock has stalled to 5000.
    clock.advanceTo(5000);
    await clock.tick();

    assert.equal(beats[1]!.at, 5000);
    assert.equal(beats[1]!.lateMs, 4000);
    assert.equal(handle.missedBeats, 1, "a beat past maxSkewMs counts as missed");

    await handle.stop();
  });

  it("routes submission failures to onError instead of an unhandled rejection", async () => {
    const clock = fakeClock();
    const errors: unknown[] = [];

    const handle = await startHeartbeat(
      baseOptions({
        now: clock.now,
        wait: clock.wait,
        submit: async () => {
          throw new Error("rpc down");
        },
        onError: (error) => errors.push(error),
      }),
    );

    await clock.tick();
    assert.equal(errors.length, 1);
    assert.equal((errors[0] as Error).message, "rpc down");
    assert.equal(handle.lastBeatAt, null, "a failed beat is not a beat");

    await handle.stop();
  });

  it("skips a duplicate beat within the same wall-clock second", async () => {
    const clock = fakeClock();
    let submissions = 0;

    const handle = await startHeartbeat(
      baseOptions({
        intervalMs: 400,
        now: clock.now,
        wait: clock.wait,
        submit: async () => {
          submissions += 1;
          return {};
        },
      }),
    );

    await clock.tick(); // t=0  → beat (second 0)
    assert.equal(submissions, 1);
    await clock.tick(); // t=400 → skipped (still second 0)
    assert.equal(submissions, 1);
    await clock.tick(); // t=800 → skipped (still second 0)
    assert.equal(submissions, 1);
    await clock.tick(); // t=1200 → beat (second 1)
    assert.equal(submissions, 2);

    await handle.stop();
  });

  it("passes a caller-supplied ledger through to onBeat", async () => {
    const clock = fakeClock();
    const beats: HeartbeatBeat[] = [];
    const handle = await startHeartbeat(
      baseOptions({
        now: clock.now,
        wait: clock.wait,
        submit: async () => ({ ledger: 4_700_123 }),
        onBeat: (beat) => beats.push(beat),
      }),
    );
    await clock.tick();
    assert.equal(beats[0]!.ledger, 4_700_123);
    await handle.stop();
  });

  it("rejects a non-positive interval", async () => {
    await assert.rejects(
      startHeartbeat(baseOptions({ intervalMs: 0 })),
      RangeError,
    );
  });

  it("reports the default-submission misconfiguration through onError", async () => {
    const clock = fakeClock();
    const errors: unknown[] = [];
    // No `submit` and no `server`: the default submission cannot run, and the
    // failure must surface via onError rather than as a rejection.
    const handle = await startHeartbeat({
      guard: GUARD,
      signer: Keypair.random(),
      intervalMs: 1000,
      now: clock.now,
      wait: clock.wait,
      onError: (error) => errors.push(error),
    });
    await clock.tick();
    assert.equal(errors.length, 1);
    assert.match(String((errors[0] as Error).message), /needs `server`/);
    await handle.stop();
  });
});

describe("startHeartbeat grace validation", () => {
  it("throws before starting when the interval exceeds grace/3", async () => {
    await assert.rejects(
      startHeartbeat(baseOptions({ intervalMs: 20_000, graceSecs: 30 })),
      HeartbeatIntervalError,
    );
  });

  it("accepts an interval within grace/3", async () => {
    const handle = await startHeartbeat(baseOptions({ intervalMs: 5_000, graceSecs: 30 }));
    await handle.stop();
  });

  it("validates against a policy read from the chain", async () => {
    const policy = { dms_grace_secs: 30n } as PolicyConfig;
    await assert.rejects(
      startHeartbeat(
        baseOptions({ intervalMs: 20_000, readPolicy: async () => policy }),
      ),
      HeartbeatIntervalError,
    );
  });

  it("warns and starts when the policy is unreadable", async () => {
    const warnings: string[] = [];
    const handle = await startHeartbeat(
      baseOptions({
        intervalMs: 20_000,
        readPolicy: async () => null,
        onWarning: (message) => warnings.push(message),
      }),
    );
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /interval <= grace\/3 check/);
    await handle.stop();
  });

  it("warns and starts when the policy read rejects", async () => {
    const warnings: string[] = [];
    const handle = await startHeartbeat(
      baseOptions({
        intervalMs: 20_000,
        readPolicy: async () => {
          throw new Error("rpc unavailable");
        },
        onWarning: (message) => warnings.push(message),
      }),
    );
    assert.equal(warnings.length, 1);
    await handle.stop();
  });

  it("does not constrain the interval when the dead-man switch is off", async () => {
    // dms_grace_secs == 0 disables the switch, so any interval is safe.
    const policy = { dms_grace_secs: 0n } as PolicyConfig;
    const handle = await startHeartbeat(
      baseOptions({ intervalMs: 20_000, readPolicy: async () => policy }),
    );
    await handle.stop();
  });
});

/**
 * Bounded retry and backoff for transient submission failures (issue #340).
 *
 * A heartbeat that fails on a transport error used to wait for the next fixed
 * interval before trying again, which could freeze an account whose grace
 * window closed in between. The retry is bounded, jittered, and never applied
 * to a policy block.
 */
describe("startHeartbeat bounded retry (issue #340)", () => {
  /**
   * The fake clock plus a record of every delay it was asked for, so the
   * backoff can be asserted exactly.
   */
  function recordingClock() {
    const clock = fakeClock();
    const delays: number[] = [];
    const wait = (ms: number, signal?: AbortSignal): Promise<void> => {
      delays.push(ms);
      return clock.wait(ms, signal);
    };
    return { clock, delays, wait, now: clock.now };
  }

  it("makes one attempt per beat when no retry policy is configured", async () => {
    const clock = fakeClock();
    let attempts = 0;
    const errors: unknown[] = [];

    const handle = await startHeartbeat(
      baseOptions({
        now: clock.now,
        wait: clock.wait,
        graceSecs: 30,
        submit: async () => {
          attempts += 1;
          throw new BroadcastError("rpc down");
        },
        onError: (error) => errors.push(error),
      }),
    );

    await clock.tick();
    assert.equal(attempts, 1, "retries are opt-in: one attempt per beat by default");
    assert.equal(errors.length, 1);
    assert.ok(errors[0] instanceof BroadcastError, "the original error is reported as-is");

    await handle.stop();
  });

  it("retries a transport failure and reports how many attempts the beat took", async () => {
    const { clock, delays, wait, now } = recordingClock();
    const beats: HeartbeatBeat[] = [];
    const warnings: string[] = [];
    const errors: unknown[] = [];
    let attempts = 0;

    const handle = await startHeartbeat(
      baseOptions({
        now,
        wait,
        graceSecs: 30,
        retry: { maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 1_000, random: () => 0.5 },
        submit: async () => {
          attempts += 1;
          if (attempts === 1) throw new BroadcastError("rpc down");
          return {};
        },
        onBeat: (beat) => beats.push(beat),
        onWarning: (message) => warnings.push(message),
        onError: (error) => errors.push(error),
      }),
    );

    await clock.tick();
    assert.equal(attempts, 1);
    assert.equal(errors.length, 0, "a failure that will be retried is not the final failure");
    assert.equal(warnings.length, 1, "the attempt and its delay are announced");
    assert.match(warnings[0]!, /attempt 1 of 3/);
    assert.match(warnings[0]!, /retrying in 50ms/);
    assert.deepEqual(
      delays,
      [0, 50],
      "the backoff is the full-jitter sample of the base window",
    );

    await clock.tick();
    assert.equal(attempts, 2);
    assert.equal(beats.length, 1);
    assert.equal(beats[0]!.attempt, 2, "the beat reports how many attempts it took");
    assert.equal(errors.length, 0, "a recovered beat is not an error");

    await handle.stop();
  });

  it("exhausts the budget and reports the final failure exactly once", async () => {
    const { clock, wait, now } = recordingClock();
    const errors: unknown[] = [];
    const warnings: string[] = [];
    let attempts = 0;

    const handle = await startHeartbeat(
      baseOptions({
        now,
        wait,
        graceSecs: 30,
        retry: { maxAttempts: 3, baseDelayMs: 10, random: () => 0 },
        submit: async () => {
          attempts += 1;
          throw new BroadcastError("rpc down");
        },
        onError: (error) => errors.push(error),
        onWarning: (message) => warnings.push(message),
      }),
    );

    await clock.tick();
    await clock.tick();
    await clock.tick();

    assert.equal(attempts, 3, "the budget bounds the attempts per beat");
    assert.equal(errors.length, 1, "the final failure is reported once");
    assert.ok(errors[0] instanceof BroadcastError);
    assert.equal(
      warnings.length,
      2,
      "only the attempts that are followed by a retry are announced",
    );

    await handle.stop();
  });

  it("never retries a policy block", async () => {
    const clock = fakeClock();
    const errors: unknown[] = [];
    let attempts = 0;
    const blocked: InvokeOutcome = {
      kind: "blocked",
      reason: "paused",
      detail: "the policy is paused",
      diagnosticEvents: [],
    };

    const handle = await startHeartbeat(
      baseOptions({
        now: clock.now,
        wait: clock.wait,
        graceSecs: 30,
        retry: { maxAttempts: 3, baseDelayMs: 10, random: () => 0 },
        submit: async () => {
          attempts += 1;
          return { outcome: blocked };
        },
        onError: (error) => errors.push(error),
      }),
    );

    await clock.tick();
    assert.equal(attempts, 1, "a refusal is a decision, not a transport failure");
    assert.equal(errors.length, 1);
    assert.ok(errors[0] instanceof HeartbeatBlockedError);
    assert.equal((errors[0] as HeartbeatBlockedError).reason, "paused");

    await handle.stop();
  });

  it("does not retry a failure the SDK cannot classify", async () => {
    const clock = fakeClock();
    const errors: unknown[] = [];
    let attempts = 0;

    const handle = await startHeartbeat(
      baseOptions({
        now: clock.now,
        wait: clock.wait,
        graceSecs: 30,
        retry: { maxAttempts: 3, baseDelayMs: 10, random: () => 0 },
        submit: async () => {
          attempts += 1;
          throw new Error("boom");
        },
        onError: (error) => errors.push(error),
      }),
    );

    await clock.tick();
    assert.equal(attempts, 1, "an unknown error is reported, not retried");
    assert.equal(errors.length, 1);
    assert.equal((errors[0] as Error).message, "boom");

    await handle.stop();
  });

  it("stops during the backoff without another attempt and without an error", async () => {
    const { clock, wait, now } = recordingClock();
    const errors: unknown[] = [];
    let attempts = 0;

    const handle = await startHeartbeat(
      baseOptions({
        now,
        wait,
        graceSecs: 30,
        retry: { maxAttempts: 3, baseDelayMs: 100, random: () => 0.5 },
        submit: async () => {
          attempts += 1;
          throw new BroadcastError("rpc down");
        },
        onError: (error) => errors.push(error),
      }),
    );

    await clock.tick();
    assert.equal(attempts, 1);

    await handle.stop();

    assert.equal(attempts, 1, "a stopped scheduler makes no further attempt");
    assert.equal(errors.length, 0, "a stop is teardown, not a failure");
  });

  it("classifies retryable and non-retryable failures", () => {
    assert.equal(isRetryableHeartbeatFailure(new BroadcastError("rpc down")), true);
    assert.equal(
      isRetryableHeartbeatFailure(new RpcTimeoutError({ stage: "invoke", aborted: false })),
      true,
    );
    assert.equal(
      isRetryableHeartbeatFailure(
        new SimulationError("probe failed", { stage: "probe", cause: new Error("offline") }),
      ),
      true,
    );
    // A policy refusal is a decision, never a transport failure.
    assert.equal(
      isRetryableHeartbeatFailure(
        new GuardBlockedError({ reason: "paused", stage: "submission" }),
      ),
      false,
    );
    assert.equal(
      isRetryableHeartbeatFailure(new HeartbeatBlockedError({ reason: "paused" })),
      false,
    );
    // Anything unclassifiable is reported, not retried.
    assert.equal(isRetryableHeartbeatFailure(new Error("boom")), false);
    assert.equal(isRetryableHeartbeatFailure("boom"), false);
  });
});

/**
 * Input validation (issue #341).
 *
 * The scheduler's inputs decide whether a beat is late or the agent is
 * misconfigured. A negative skew threshold, an unusable grace window, or a
 * callback that is not callable must fail before the first beat — and before
 * the grace window is even read from the chain.
 */
describe("startHeartbeat input validation (issue #341)", () => {
  it("rejects a non-finite maxSkewMs", async () => {
    for (const maxSkewMs of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      await assert.rejects(
        startHeartbeat(baseOptions({ maxSkewMs })),
        (error: unknown) =>
          error instanceof RangeError && /maxSkewMs/.test((error as Error).message),
      );
    }
  });

  it("rejects a negative maxSkewMs", async () => {
    await assert.rejects(
      startHeartbeat(baseOptions({ maxSkewMs: -1 })),
      (error: unknown) =>
        error instanceof RangeError && /maxSkewMs/.test((error as Error).message),
    );
  });

  it("accepts a zero and a positive maxSkewMs", async () => {
    const strict = await startHeartbeat(baseOptions({ maxSkewMs: 0 }));
    await strict.stop();
    const tolerant = await startHeartbeat(baseOptions({ maxSkewMs: 2_000 }));
    await tolerant.stop();
  });

  it("rejects a grace window that cannot survive the conversion", async () => {
    for (const graceSecs of [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      -1,
      1.5,
      Number.MAX_SAFE_INTEGER + 2,
    ]) {
      await assert.rejects(
        startHeartbeat(baseOptions({ graceSecs })),
        (error: unknown) =>
          error instanceof RangeError && /graceSecs/.test((error as Error).message),
      );
    }
  });

  it("rejects a negative bigint grace window", async () => {
    await assert.rejects(
      startHeartbeat(baseOptions({ graceSecs: -1n })),
      (error: unknown) =>
        error instanceof RangeError && /graceSecs/.test((error as Error).message),
    );
  });

  it("accepts the grace values that survive the conversion", async () => {
    for (const graceSecs of [0, 30, 30n, Number.MAX_SAFE_INTEGER]) {
      const handle = await startHeartbeat(baseOptions({ graceSecs, intervalMs: 1_000 }));
      await handle.stop();
    }
  });

  it("rejects a scheduler callback that is not callable", async () => {
    await assert.rejects(
      startHeartbeat(baseOptions({ onBeat: "not-a-function" as never })),
      TypeError,
    );
    await assert.rejects(startHeartbeat(baseOptions({ wait: 42 as never })), TypeError);
    await assert.rejects(startHeartbeat(baseOptions({ now: 42 as never })), TypeError);
  });

  it("rejects an unusable retry budget", async () => {
    await assert.rejects(startHeartbeat(baseOptions({ retry: { maxAttempts: 0 } })), RangeError);
    await assert.rejects(
      startHeartbeat(baseOptions({ retry: { maxAttempts: 1.5 } })),
      RangeError,
    );
    await assert.rejects(
      startHeartbeat(baseOptions({ retry: { baseDelayMs: -1 } })),
      RangeError,
    );
    await assert.rejects(
      startHeartbeat(baseOptions({ retry: { maxDelayMs: Number.NaN } })),
      RangeError,
    );
  });

  it("rejects before anything is scheduled, submitted or read from the chain", async () => {
    let submissions = 0;
    let policyReads = 0;
    await assert.rejects(
      startHeartbeat(
        baseOptions({
          maxSkewMs: -1,
          submit: async () => {
            submissions += 1;
            return {};
          },
          readPolicy: async () => {
            policyReads += 1;
            return null;
          },
        }),
      ),
      RangeError,
    );
    assert.equal(submissions, 0, "no beat may be submitted");
    assert.equal(policyReads, 0, "and the grace window must not even be read");
  });
});
