/**
 * TODO-LR-4 (P2, codex C13) — re-entrancy guard for the stall-detector
 * `setInterval` tick at worker.ts.
 *
 * Before this fix, `setInterval(async () => { ... })` had try/catch on
 * every await so it never crashed, but nothing stopped a slow tick (e.g.
 * `handleStalled()` blocked on a saturated PgBouncer pool) from
 * overlapping with the NEXT interval firing. During an outage, 3
 * concurrent stall-detector loops could pile 9 pending connection
 * acquisitions per tick on an already-saturated pool — amplifying the
 * very stall they're trying to detect.
 *
 * `createStalledDetectorTick` wraps the extracted tick body
 * (`runStalledDetectorTick`) with the same `tickInFlight` boolean-flag
 * pattern `launchJob`'s lock-renewal timer already uses. This file drives
 * the guard directly (manual invocation, no real `setInterval`, no
 * engine/DB) to prove overlapping ticks are suppressed while a slow tick
 * is in flight, and that the guard releases once it settles.
 */

import { describe, expect, test } from 'bun:test';
import {
  createStalledDetectorTick,
  runStalledDetectorTick,
} from '../src/core/minions/worker.ts';
import type { MinionJob } from '../src/core/minions/types.ts';

// --- fakes ------------------------------------------------------------

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function makeFakeQueue(overrides: {
  handleStalled?: () => Promise<{ requeued: MinionJob[]; dead: MinionJob[] }>;
  handleTimeouts?: () => Promise<MinionJob[]>;
  handleWallClockTimeouts?: () => Promise<MinionJob[]>;
} = {}) {
  return {
    handleStalled: overrides.handleStalled ?? (async () => ({ requeued: [] as MinionJob[], dead: [] as MinionJob[] })),
    handleTimeouts: overrides.handleTimeouts ?? (async () => [] as MinionJob[]),
    handleWallClockTimeouts: overrides.handleWallClockTimeouts ?? (async () => [] as MinionJob[]),
  };
}

// The tick body chains three sequential awaits (handleStalled ->
// handleTimeouts -> handleWallClockTimeouts) plus a `.finally()` on the
// outer guard promise. Several microtask-queue drains are needed before
// `tickInFlight` resets back to false. Same pattern as
// test/ingestion/daemon.test.ts's local flushMicrotasks helper.
async function flushMicrotasks(times = 6): Promise<void> {
  for (let i = 0; i < times; i++) {
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
  }
}

describe('createStalledDetectorTick — TODO-LR-4 re-entrancy guard', () => {
  test('a slow in-flight tick suppresses a subsequent tick', async () => {
    const gate = deferred<{ requeued: MinionJob[]; dead: MinionJob[] }>();
    let handleStalledCalls = 0;
    const queue = makeFakeQueue({
      handleStalled: () => {
        handleStalledCalls++;
        return gate.promise;
      },
    });
    const tick = createStalledDetectorTick(queue, 30000);

    tick(); // tick #1 fires — handleStalled() is now in flight (gate unresolved)
    tick(); // tick #2 fires immediately while #1 is still pending

    expect(handleStalledCalls).toBe(1); // #2 was suppressed by the guard

    gate.resolve({ requeued: [], dead: [] });
    await flushMicrotasks();

    tick(); // guard has reset now that #1 settled — this must go through
    expect(handleStalledCalls).toBe(2);
  });

  test('multiple overlapping ticks during one slow in-flight call all collapse to one', async () => {
    const gate = deferred<{ requeued: MinionJob[]; dead: MinionJob[] }>();
    let handleStalledCalls = 0;
    const queue = makeFakeQueue({
      handleStalled: () => {
        handleStalledCalls++;
        return gate.promise;
      },
    });
    const tick = createStalledDetectorTick(queue, 30000);

    // Simulate 3 overlapping interval firings during a PgBouncer stall
    // (the exact scenario TODO-LR-4 describes).
    tick();
    tick();
    tick();

    expect(handleStalledCalls).toBe(1);

    gate.resolve({ requeued: [], dead: [] });
    await flushMicrotasks();
  });

  test('a fast tick does not block the next interval firing', async () => {
    let handleStalledCalls = 0;
    const queue = makeFakeQueue({
      handleStalled: async () => {
        handleStalledCalls++;
        return { requeued: [], dead: [] };
      },
    });
    const tick = createStalledDetectorTick(queue, 30000);

    tick();
    await flushMicrotasks();
    tick();
    await flushMicrotasks();

    expect(handleStalledCalls).toBe(2);
  });
});

describe('runStalledDetectorTick — extracted tick body', () => {
  test('one detector throwing does not block the others (independent try/catch)', async () => {
    let timeoutsCalled = false;
    let wallClockCalled = false;
    const queue = makeFakeQueue({
      handleStalled: async () => {
        throw new Error('boom');
      },
      handleTimeouts: async () => {
        timeoutsCalled = true;
        return [];
      },
      handleWallClockTimeouts: async () => {
        wallClockCalled = true;
        return [];
      },
    });

    // Should not throw — every await is individually try/caught.
    await runStalledDetectorTick(queue, 30000);

    expect(timeoutsCalled).toBe(true);
    expect(wallClockCalled).toBe(true);
  });
});
