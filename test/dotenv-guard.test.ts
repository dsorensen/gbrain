/**
 * Pins `test/helpers/dotenv-guard-preload.ts` — the guard that stops the
 * repo-root `.env` from leaking real credentials into test processes.
 *
 * Background: Bun auto-loads `<repo-root>/.env` into every process it spawns.
 * On a developer machine that file holds real keys, so tests that gate on a
 * credential being absent stop skipping and take real-network paths, while CI
 * (no `.env`) behaves differently. The guard deletes exactly the vars whose
 * value matches the file's, leaving shell-exported values alone.
 */
import { describe, expect, test } from 'bun:test';
import { parseDotenv, scrubDotenvValues } from './helpers/dotenv-guard-preload.ts';

describe('parseDotenv', () => {
  test('parses plain KEY=value pairs', () => {
    const parsed = parseDotenv('FOO=bar\nBAZ=qux\n');
    expect(parsed.get('FOO')).toBe('bar');
    expect(parsed.get('BAZ')).toBe('qux');
    expect(parsed.size).toBe(2);
  });

  test('ignores blank lines and full-line comments', () => {
    const parsed = parseDotenv('# a comment\n\nFOO=bar\n   # indented comment\n');
    expect(parsed.size).toBe(1);
    expect(parsed.get('FOO')).toBe('bar');
  });

  test('strips an `export ` prefix', () => {
    expect(parseDotenv('export FOO=bar').get('FOO')).toBe('bar');
  });

  test('strips surrounding single or double quotes', () => {
    const parsed = parseDotenv(`FOO="bar baz"\nQUX='quux'\n`);
    expect(parsed.get('FOO')).toBe('bar baz');
    expect(parsed.get('QUX')).toBe('quux');
  });

  test('keeps `#` that is inside quotes but strips a trailing inline comment', () => {
    const parsed = parseDotenv(`HASHED="se#cret"\nPLAIN=value # trailing\n`);
    expect(parsed.get('HASHED')).toBe('se#cret');
    expect(parsed.get('PLAIN')).toBe('value');
  });

  test('skips malformed lines and non-identifier keys', () => {
    const parsed = parseDotenv('no-equals-sign\n=novalue\n1BAD=x\nGOOD=y\n');
    expect(parsed.size).toBe(1);
    expect(parsed.get('GOOD')).toBe('y');
  });

  test('preserves a value containing `=`', () => {
    expect(parseDotenv('URL=postgres://u:p@h/db?a=b').get('URL')).toBe(
      'postgres://u:p@h/db?a=b',
    );
  });
});

describe('scrubDotenvValues', () => {
  test('deletes vars whose value came from the .env file', () => {
    const env: Record<string, string | undefined> = { OPENAI_API_KEY: 'sk-from-file' };
    const scrubbed = scrubDotenvValues(env, new Map([['OPENAI_API_KEY', 'sk-from-file']]));

    expect(scrubbed).toEqual(['OPENAI_API_KEY']);
    expect('OPENAI_API_KEY' in env).toBe(false);
  });

  test('leaves a shell-exported value alone when it differs from the file', () => {
    const env: Record<string, string | undefined> = { OPENAI_API_KEY: 'sk-from-shell' };
    const scrubbed = scrubDotenvValues(env, new Map([['OPENAI_API_KEY', 'sk-from-file']]));

    expect(scrubbed).toEqual([]);
    expect(env.OPENAI_API_KEY).toBe('sk-from-shell');
  });

  test('ignores file keys that are not present in the environment', () => {
    const env: Record<string, string | undefined> = {};
    expect(scrubDotenvValues(env, new Map([['ABSENT', 'x']]))).toEqual([]);
  });

  test('returns scrubbed names sorted and touches nothing else', () => {
    const env: Record<string, string | undefined> = {
      ZED: '1',
      ALPHA: '2',
      UNRELATED: 'keep',
    };
    const scrubbed = scrubDotenvValues(
      env,
      new Map([
        ['ZED', '1'],
        ['ALPHA', '2'],
      ]),
    );

    expect(scrubbed).toEqual(['ALPHA', 'ZED']);
    expect(env.UNRELATED).toBe('keep');
  });

  test('does not delete a var whose value merely shares a prefix', () => {
    const env: Record<string, string | undefined> = { TOKEN: 'abc123' };
    scrubDotenvValues(env, new Map([['TOKEN', 'abc']]));
    expect(env.TOKEN).toBe('abc123');
  });
});

describe('preload wiring', () => {
  test('the running test process has no repo-root .env credentials', async () => {
    const { existsSync, readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const dotenvPath = join(import.meta.dir, '..', '.env');

    if (!existsSync(dotenvPath)) {
      // CI shape: nothing to scrub, guard is a no-op. Assert that explicitly
      // rather than silently passing on a missing file.
      expect(existsSync(dotenvPath)).toBe(false);
      return;
    }

    // Developer shape: every value the file assigns must be gone from the
    // environment this test is running in. If this fails, the preload is not
    // wired in bunfig.toml and every other test is running against real keys.
    for (const [key, value] of parseDotenv(readFileSync(dotenvPath, 'utf8'))) {
      expect(process.env[key]).not.toBe(value);
    }
  });
});
