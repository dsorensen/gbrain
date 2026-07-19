/**
 * Pre-test setup: stop the developer's machine from poisoning test runs.
 *
 * Two leaks, same class — state that exists on a developer box but never in CI,
 * which silently changes what the suite is testing:
 *
 *   1. The repo-root `.env` (real credentials).
 *   2. The real `~/.gbrain` (the developer's live brain config).
 *
 * ## Leak 1 — repo-root `.env`
 *
 * Bun auto-loads `<repo-root>/.env` into `process.env` of every process it
 * spawns, including `bun test`. On a developer machine that file typically
 * holds real credentials (`OPENAI_API_KEY`, ...). Tests then behave
 * differently than they do in CI, where no such file exists:
 *
 *   - Tests that gate on a credential being ABSENT (`if (!process.env.X) skip`)
 *     stop skipping and take real-network paths — slow, flaky, and billable.
 *   - Credential-preflight assertions that should fail loudly exit 0 instead,
 *     so a genuine regression reads as green.
 *
 * This preload deletes exactly the variables that came from the repo-root
 * `.env` file, identified by value equality: a key is scrubbed only when
 * `process.env[KEY]` is byte-identical to what `.env` assigns it. A value
 * exported by the real shell environment or by a test wrapper therefore
 * survives, and CI (no `.env` on disk) is a pure no-op.
 *
 * Escape hatch: set `GBRAIN_ALLOW_REPO_DOTENV=1` to keep the file's values,
 * e.g. when deliberately exercising a live-credential path locally.
 *
 * ## Leak 2 — the real `~/.gbrain`
 *
 * `configDir()` falls back to `os.homedir()/.gbrain` when `GBRAIN_HOME` is
 * unset, so an unset run reads the developer's live brain config — engine,
 * search mode, embedding model, source boosts. In CI that directory does not
 * exist, so config resolution lands on defaults and the same test asserts
 * against different inputs.
 *
 * Observed cost before this guard: `hybrid-reranker-integration`,
 * `autocut-integration`, `llm-intent-hybrid-integration` and
 * `unified-multimodal` reported 10 failures locally and zero in CI. All 10 pass
 * once `GBRAIN_HOME` points somewhere empty.
 *
 * So when `GBRAIN_HOME` is unset, point it at a fresh per-process temp dir.
 * A value already in the environment came from the caller (a shell export or a
 * test wrapper) and is left alone; files that manage `GBRAIN_HOME` themselves
 * are unaffected, since they set it after this preload runs.
 *
 * Escape hatch: `GBRAIN_ALLOW_REAL_HOME=1`.
 *
 * ## Ordering
 *
 * Imported by `bunfig.toml` FIRST in the `preload` array — it must run before
 * `legacy-embedding-preload.ts`, which snapshots `{ ...process.env }` into the
 * gateway config.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Repo root, resolved from this file's location (test/helpers/ → ../..). */
const REPO_ROOT = join(import.meta.dir, '..', '..');
const DOTENV_PATH = join(REPO_ROOT, '.env');

/**
 * Minimal `.env` parser covering the shapes Bun itself accepts: `KEY=value`,
 * optional `export ` prefix, single- or double-quoted values, `#` comments,
 * and blank lines. Inline comments are only stripped from unquoted values —
 * a `#` inside quotes is part of the value.
 */
export function parseDotenv(contents: string): Map<string, string> {
  const out = new Map<string, string>();

  for (const rawLine of contents.split('\n')) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;

    const withoutExport = line.startsWith('export ') ? line.slice(7).trim() : line;
    const eq = withoutExport.indexOf('=');
    if (eq <= 0) continue;

    const key = withoutExport.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;

    let value = withoutExport.slice(eq + 1).trim();
    const quote = value[0];
    if ((quote === '"' || quote === "'") && value.endsWith(quote) && value.length >= 2) {
      value = value.slice(1, -1);
    } else {
      const hash = value.indexOf(' #');
      if (hash !== -1) value = value.slice(0, hash).trimEnd();
    }

    out.set(key, value);
  }

  return out;
}

/**
 * Delete every `env` entry whose value matches what `dotenv` assigns it.
 * Returns the scrubbed key names, sorted, for reporting. Exported for the
 * test that pins this behavior.
 */
export function scrubDotenvValues(
  env: Record<string, string | undefined>,
  dotenv: Map<string, string>,
): string[] {
  const scrubbed: string[] = [];

  for (const [key, value] of dotenv) {
    if (env[key] === value) {
      delete env[key];
      scrubbed.push(key);
    }
  }

  return scrubbed.sort();
}

/**
 * Point `GBRAIN_HOME` at a fresh temp dir when the caller left it unset, so
 * `configDir()` cannot fall back to the developer's real `~/.gbrain`. Returns
 * the directory it claimed, or `null` when it left the environment alone.
 * Exported for the test that pins this behavior.
 */
export function isolateGbrainHome(
  env: Record<string, string | undefined>,
  makeTempDir: () => string,
): string | null {
  if (env.GBRAIN_ALLOW_REAL_HOME === '1') return null;
  if (env.GBRAIN_HOME !== undefined) return null;

  const dir = makeTempDir();
  env.GBRAIN_HOME = dir;
  return dir;
}

if (process.env.GBRAIN_ALLOW_REPO_DOTENV !== '1' && existsSync(DOTENV_PATH)) {
  const dotenv = parseDotenv(readFileSync(DOTENV_PATH, 'utf8'));
  const scrubbed = scrubDotenvValues(process.env, dotenv);

  if (scrubbed.length > 0) {
    // Names only — never the values.
    console.error(
      `[env-isolation] Ignored ${scrubbed.length} var(s) from repo-root .env for this test run: ` +
        `${scrubbed.join(', ')}. CI has no .env, so tests must not depend on them. ` +
        `Set GBRAIN_ALLOW_REPO_DOTENV=1 to keep them.`,
    );
  }
}

const claimedHome = isolateGbrainHome(process.env, () =>
  mkdtempSync(join(tmpdir(), 'gbrain-test-home-')),
);

if (claimedHome !== null) {
  // Best-effort: the dir is under tmpdir(), so a missed cleanup (hard kill,
  // crash) is swept by the OS rather than left in the developer's home.
  process.on('exit', () => {
    try {
      rmSync(claimedHome, { recursive: true, force: true });
    } catch {
      // Never let cleanup fail a run.
    }
  });
}
