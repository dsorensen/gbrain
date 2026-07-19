/**
 * Pre-test setup: stop the repo-root `.env` from poisoning test runs.
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
 * Imported by `bunfig.toml` FIRST in the `preload` array — it must run before
 * `legacy-embedding-preload.ts`, which snapshots `{ ...process.env }` into the
 * gateway config.
 */
import { existsSync, readFileSync } from 'node:fs';
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

if (process.env.GBRAIN_ALLOW_REPO_DOTENV !== '1' && existsSync(DOTENV_PATH)) {
  const dotenv = parseDotenv(readFileSync(DOTENV_PATH, 'utf8'));
  const scrubbed = scrubDotenvValues(process.env, dotenv);

  if (scrubbed.length > 0) {
    // Names only — never the values.
    console.error(
      `[dotenv-guard] Ignored ${scrubbed.length} var(s) from repo-root .env for this test run: ` +
        `${scrubbed.join(', ')}. CI has no .env, so tests must not depend on them. ` +
        `Set GBRAIN_ALLOW_REPO_DOTENV=1 to keep them.`,
    );
  }
}
