/**
 * Fast-tier coverage for `src/core/db.ts`'s module-level Postgres
 * connection singleton state machine (`sql` / `connectedUrl`,
 * `getConnection()` / `connect()` / `disconnect()`).
 *
 * Written per `PREP_item4.md` §Open Question 3 / `PREP_item4_baseline.md`:
 * before this file, EVERY test exercising `connect()`/`disconnect()`/the
 * create-vs-join race went through a real Postgres connection gated by
 * `DATABASE_URL` (`test/e2e/*`) — zero fast/unit-tier coverage of the
 * singleton mechanics themselves.
 *
 * Empirically verified (not assumed): the `postgres(url, opts)`
 * constructor IS lazy (no I/O), but `connect()` immediately runs
 * `await sql\`SELECT 1\`` as a liveness probe, which DOES attempt a real
 * network connection even against a fake/unreachable URL. So this file
 * mocks the `postgres` import at the module level rather than relying on
 * `postgres()`'s own laziness — the smallest dependency seam available
 * (db.ts has no injectable factory, so the import itself is the seam).
 *
 * `mock.module()` requires `*.serial.test.ts` naming per
 * `scripts/check-test-isolation.sh` (R2 — mock.module leaks across files
 * sharing a shard process). Still fast tier: `bun run test`'s serial pass
 * runs `*.serial.test.ts` files after the parallel shards, per
 * docs/TESTING.md.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';

// --- fake postgres.js ------------------------------------------------------
//
// db.ts's connect() does: `sql = postgres(url, opts); await sql\`SELECT 1\`;`
// then `setSessionDefaults(sql)` (a no-op shim). The tagged-template call
// means the returned "sql" must itself be callable. postgres.js's real
// client is a callable function with methods hung off it; we mirror that
// shape minimally.

interface FakeSql {
  (...args: unknown[]): Promise<unknown[]>;
  end: ReturnType<typeof mock>;
}

let constructCount = 0;
const constructedUrls: string[] = [];

function makeFakeSql(): FakeSql {
  const fn = (async (..._args: unknown[]) => []) as unknown as FakeSql;
  fn.end = mock(async (_opts?: { timeout?: number }) => {});
  return fn;
}

function fakePostgresFactory(url: string, _opts?: Record<string, unknown>): FakeSql {
  constructCount++;
  constructedUrls.push(url);
  return makeFakeSql();
}
fakePostgresFactory.BigInt = 'bigint-marker';

mock.module('postgres', () => ({ default: fakePostgresFactory }));

// db.ts must be imported AFTER mock.module() registers the fake, so its
// top-level `import postgres from 'postgres'` binds to the fake.
const db = await import('../../src/core/db.ts');

describe('src/core/db.ts — module singleton state machine', () => {
  beforeEach(async () => {
    // Guarantee a clean starting state for every test regardless of
    // execution order — disconnect() is idempotent (no-ops when sql is
    // already null).
    await db.disconnect();
    constructCount = 0;
    constructedUrls.length = 0;
  });

  afterEach(async () => {
    await db.disconnect();
  });

  test('getConnection() throws before connect() has ever been called', () => {
    expect(() => db.getConnection()).toThrow();
    try {
      db.getConnection();
      throw new Error('expected getConnection() to throw');
    } catch (e) {
      expect((e as Error).message).toContain('No database connection');
    }
  });

  test('connect() throws when database_url is missing', async () => {
    let err: unknown;
    try {
      await db.connect({});
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain('No database URL');
    // No postgres() construction should have been attempted.
    expect(constructCount).toBe(0);
  });

  test('first connect() creates the singleton and returns true (owner)', async () => {
    const owner = await db.connect({ database_url: 'postgres://fake-1/db' });
    expect(owner).toBe(true);
    expect(constructCount).toBe(1);
    expect(constructedUrls).toEqual(['postgres://fake-1/db']);
    // getConnection() no longer throws once connected.
    expect(() => db.getConnection()).not.toThrow();
  });

  test('second connect() with the SAME url joins and returns false (joiner)', async () => {
    const owner = await db.connect({ database_url: 'postgres://fake-2/db' });
    expect(owner).toBe(true);
    const joiner = await db.connect({ database_url: 'postgres://fake-2/db' });
    expect(joiner).toBe(false);
    // Only one real postgres() construction — the join did not create a
    // second pool.
    expect(constructCount).toBe(1);
  });

  test('second connect() with a DIFFERENT url warns and keeps the existing connection', async () => {
    const originalWarn = console.warn;
    const warnings: unknown[][] = [];
    console.warn = (...args: unknown[]) => { warnings.push(args); };
    try {
      await db.connect({ database_url: 'postgres://fake-3a/db' });
      const first = db.getConnection();

      const joiner = await db.connect({ database_url: 'postgres://fake-3b/db' });

      expect(joiner).toBe(false);
      // The existing connection is untouched — same instance, no new pool.
      expect(db.getConnection()).toBe(first);
      expect(constructCount).toBe(1);
      // A warning fired about the mismatched URL.
      const warnedAboutMismatch = warnings.some(args =>
        args.some(a => typeof a === 'string' && /different database_url/i.test(a)),
      );
      expect(warnedAboutMismatch).toBe(true);
    } finally {
      console.warn = originalWarn;
    }
  });

  test('disconnect() then getConnection() throws again', async () => {
    await db.connect({ database_url: 'postgres://fake-4/db' });
    expect(() => db.getConnection()).not.toThrow();

    await db.disconnect();

    expect(() => db.getConnection()).toThrow();
    try {
      db.getConnection();
      throw new Error('expected getConnection() to throw');
    } catch (e) {
      expect((e as Error).message).toContain('No database connection');
    }
  });

  test('reconnect after disconnect works and creates a fresh singleton', async () => {
    const first = await db.connect({ database_url: 'postgres://fake-5/db' });
    expect(first).toBe(true);
    const firstConn = db.getConnection();

    await db.disconnect();

    const second = await db.connect({ database_url: 'postgres://fake-5/db' });
    expect(second).toBe(true); // reconnecting after a clean disconnect is ownership again, not a join
    expect(constructCount).toBe(2); // one postgres() call per connect() cycle

    const secondConn = db.getConnection();
    expect(secondConn).not.toBe(firstConn); // a genuinely new pool, not the stale reference
  });
});
