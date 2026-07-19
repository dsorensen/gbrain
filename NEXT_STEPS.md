# Next steps

Working notes for whoever picks this up next. Current state, then open items
ranked by leverage. Update this file as items close — it is the handoff, not a
changelog. Release history lives in `CHANGELOG.md` and git.

Last updated: 2026-07-19.

## Where things stand

- `master` is at **0.42.63.0**. PR #1 (frontmatter_filter, `query` types,
  persistent `search.source_boosts`) merged clean — all checks green.
- Branch `dsorensen/lr4-guard-db-coverage` → **PR #2**, version **0.42.63.1**:
  the stall-detector re-entrancy guard (TODO-LR-4), fast-tier coverage for the
  DB connection singleton, and test-environment isolation.
- Remotes are guardrailed: `origin` = the fork (writable), `upstream` = the
  source repo with its push URL deliberately set to a bogus value. PRs and CI
  resolve inside the fork with no `--repo` flag.

## Open items

### 1. Remaining `TODO-LR-*` reliability items

All still open in `TODOS.md`. LR-2 and LR-3 are small and self-contained — the
best next pickup.

| Item | What | Size |
|---|---|---|
| TODO-LR-1 | Surrogate-pair fix for `synthesize.ts` (from an earlier upstream PR) | medium |
| TODO-LR-2 | New doctor check: `lock_renewal_health` | small |
| TODO-LR-3 | Wire `pruneOldLockRenewalAuditFiles(30)` into a scheduled path | small |
| TODO-LR-5 | Bare-quoted hostname/username redactor patterns | small |

Note the lesson from LR-4: **its recorded location reference was stale** and
pointed at a file that no longer exists. Verify the site before trusting the
line number in any of these.

### 2. The `db.ts` singleton refactor stays closed — unless evidence

Recorded at `TODOS.md:1043`. The reopen-condition has not fired: no
disconnect-class bugs since v0.41.28.0. Two things a future attempt inherits:

- The prior adversarial review's "15 substantive objections" are
  **unrecoverable** — the source plan file is gone. Only 4 survive, via
  `TODOS.md:1045` and the v0.41.28.0 `CHANGELOG.md` entry. Reconstructing the
  other 11 is guesswork; do not claim they were addressed.
- The real blast radius is **50 touch points across 12 files**, not the ~120
  quoted in the original survey.

`test/core/db-singleton.serial.test.ts` now exists as the verification gate, so
a future attempt has something to hold it honest.

### 3. Live-brain health: orphan ratio is failing

`gbrain doctor` on the live brain: 68 OK, **1 FAIL**, plus warnings.

- **FAIL `orphan_ratio`** — 93% (448/481 linkable pages have no inbound links).
  Fix: `gbrain extract links --by-mention`.
- Downstream of the same cause: `entity_link_coverage` 16% (target 70%),
  `timeline_coverage` 1% (target 90%), `graph_signals_coverage` 6.9% — below the
  10% floor where the graph signal starts firing at all, so relational retrieval
  is effectively inert on this brain. `gbrain extract all` addresses the cluster.
- `brain_score` 50/100, entirely from the link/timeline/orphan components
  (embed is a full 35/35).
- `extract_atoms_backlog` — 32 pages eligible, but the active pack does not
  declare `extract_atoms`. Either declare it in the pack or drain manually.
- `sync_failures` — 1 unresolved `SLUG_MISMATCH`: a file whose frontmatter slug
  disagrees with its path-derived slug.
- `subagent_capability` — `chat_model` is a non-Anthropic model and
  `ANTHROPIC_API_KEY` is unset, so `dream` / `agent run` / `autopilot` will fail
  at job submission. Either set the key or
  `gbrain config set agent.use_gateway_loop true`.

### 4. Retrieval finding: conversational queries return nothing

On the live brain (481 pages / 489 chunks), single-word queries return 20
results while natural-language questions of the form "what did I learn about X"
return **zero**. Eight such queries were tried; one returned 3 results, seven
returned none.

This is worth a real look — it is the shape of query the product is pitched on,
and roughly one chunk per page suggests chunking may be the lever rather than
ranking. Not investigated here.

### 5. Two smaller findings from the U5/U10 verification

- **`list --limit` clamps at 100.** `--limit 500` with a filter matching 190
  rows returned 100. Filters matching fewer than 100 rows matched the database
  exactly (64, 54, and an AND-combined 54), so the filter itself is correct —
  the cap is elsewhere. Either document it or thread the limit through.
- **`people/` boost is a no-op.** With `people/` at 1.2, mean rank change across
  the sample was exactly `+0.00` while `lessons/` (same factor) moved −5.25.
  Probably tie-breaking or those pages already sitting at their ceiling, but it
  means the boost map is not doing what its numbers suggest for that prefix.

### 6. One pre-existing serial-tier failure

`test/brain-repo-durability.serial.test.ts` → `hardenBrainRepo > installs hook
(local, untracked, +x), helper, and AGENTS rules` fails locally (18 pass / 1
fail). Confirmed pre-existing and unrelated to any change here: it fails
identically with both test-isolation guards disabled
(`GBRAIN_ALLOW_REAL_HOME=1 GBRAIN_ALLOW_REPO_DOTENV=1`). The rest of the tier is
green — 82 files, 775 passing.

Its sibling `brain-durability-hook.serial.test.ts` is the inverse and worth a
glance: it *fails* with the guards off and *passes* with them on, which suggests
it was quietly depending on the developer's real `~/.gbrain`.

### 7. Unexplained: `GBRAIN_HOME` and `HOME` are not interchangeable

`configDir()` should resolve `GBRAIN_HOME=$T` and `HOME=$T` (with `GBRAIN_HOME`
unset) to the same `$T/.gbrain`. Empirically the CLI does not behave the same:

```
mkdir -p $T/.gbrain/migrations
echo '{"version":"0.11.0","status":"partial"}' > $T/.gbrain/migrations/completed.jsonl

HOME=$T                  bun run src/cli.ts skillpack-check --quiet   # exit 1 — detects it
HOME=$T GBRAIN_HOME=$T   bun run src/cli.ts skillpack-check --quiet   # exit 0 — misses it
```

Same for `doctor`'s half-migrated Minions detection and `init --migrate-only`.
Not chased down here. It is **not** in `apply-migrations --list` — that layer
reports identically under both — so the divergence is somewhere in the doctor
path `skillpack-check` wraps.

Why it matters beyond tests: `GBRAIN_HOME` is the documented way to point gbrain
at a non-default brain, so if half-migration detection silently no-ops under it,
real multi-brain users get a false healthy.

The three affected suites (`skillpack-check`, `doctor-minions-check`,
`init-migrate-only`) now `delete env.GBRAIN_HOME` from their subprocess env,
which restores exactly their pre-existing behavior. That is a deliberate
work-around, not a fix — when the underlying difference is resolved, those
deletes should become unnecessary.

### 8. Repo hygiene

- **Untracked planning docs at the repo root**, deliberately kept out of both
  PRs: `GBRAIN_COMPARISONS_PERPLEXITY.md`, `GBRAIN_MIGRATION_PLAN.md`,
  `GBRAIN_VS_*.md`, `NOTION_ENRICHMENT_PLAN.md`, `PREP_item4.md`,
  `PREP_item4_baseline.md`, `notion-enrichment-agent-prompt.md`,
  `docs/plans/2026-07-18-001-*.md`, and `.serena/`. Decide: commit under
  `docs/plans/`, or delete. They have survived several sessions untouched.
- **Two stale git worktrees** left by earlier sessions, both detached and in
  `/tmp`: `csm-review-pr-2` and `master-baseline`. Check them for uncommitted
  work before `git worktree remove`.

## Environment notes (save the next session the rediscovery)

- **`/ship` and `/document-release` are not installed here.** Releases are
  hand-rolled against the IRON RULES inlined in `CLAUDE.md` — the version trio
  audit (`VERSION` / `package.json` / `CHANGELOG.md`), version-first PR titles,
  surgical staging.
- **Sandbox blocks these**; they need `dangerouslyDisableSandbox: true`:
  the Docker socket, `gh` / any github.com API call (TLS `x509: OSStatus -26276`),
  `.git/config` writes (`git branch -f` fails to record upstream), connections to
  the live brain's Postgres, and writes under `~/.gbrain`. A sandboxed test run
  can fail for these reasons alone — re-run outside the sandbox before believing
  a failure. This cost real time here: the frontmatter e2e read as 0 pass / 1
  fail sandboxed and 11 pass / 0 fail outside it.
- **Live brain**: Postgres on `localhost:5433`, bound to loopback only, served by
  a Homebrew instance (not Docker). `pg_isready` reports "no response" from inside
  the sandbox even when it is up.
- **Test Postgres**: container `gbrain-test-pg` on host port **5435**
  (`gbrain_test`, postgres/postgres). `docker-compose.test.yml` wants 5434, which
  an unrelated project holds. Run:
  `DATABASE_URL='postgresql://postgres:postgres@localhost:5435/gbrain_test' bun test <file>`
- **The compiled binary cannot init a PGLite brain.** `bun run build` produces a
  working binary for most commands, but `gbrain init --engine pglite` dies with
  `Extension bundle not found: file:///$bunfs/vector.tar.gz` (and `pg_trgm`) — the
  PGLite extension bundles are not embedded by `bun build --compile`. Use
  `bun src/cli.ts` for PGLite work. Worth a proper fix or a clear error message.
- **Serial tests must run one process per file** with `--max-concurrency=1`.
  Batching them into a single `bun test` invocation produces spurious failures.
  Use `bash scripts/run-serial-tests.sh`.
- **`sha256sum` and `timeout`/`gtimeout` are absent** on this machine.
  `test/scripts/ci-cache-hash.test.ts` fails for that reason alone — pre-existing
  and unrelated to any change.
- **The full `bun run test` does not complete here.** The machine is CPU
  oversubscribed (load ~10–48 against 4 performance cores). Use scoped runs plus
  the serial tier, and treat CI as authoritative.
- **A background checkpoint hook auto-commits untracked files** at unpredictable
  moments. It has fired between a `git rev-parse HEAD` check and a
  `git commit --amend`, landing the amend on the wrong commit. Do the
  reset/add/amend in a single bash call and verify `git log -1 --format=%s`
  immediately after.
