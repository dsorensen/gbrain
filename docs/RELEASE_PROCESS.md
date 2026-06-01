# Release, changelog & PR process

> The full release machinery for gbrain, moved out of `CLAUDE.md` so it isn't
> loaded into every agent session. The `/ship` and `/document-release` skills
> read this. Cross-cutting guardrails that apply to any commit or PR (the
> privacy / scrub-real-names rule and the responsible-disclosure rule) stay in
> `CLAUDE.md`.

## Version locations (single source of truth: `VERSION` file)

Every release advances the version in **five files at once**. Keep these in
sync. `/ship` enforces this via Step 12's idempotency check (VERSION vs
package.json drift), but the canonical list lives here so future runs and
the auto-update agent know where to look.

**Version format is mandatory: `MAJOR.MINOR.PATCH.MICRO` (four numeric
segments, dot-separated, no leading `v`).** Every new release MUST use the
4-segment form. The `.MICRO` slot is the dot-suffix follow-up channel: when
a release ships its commit subject ahead of its VERSION bump (e.g. PR #795
landing as `v0.31.4` without bumping the file), the corrective ship lands
as `0.31.4.1` rather than churning the patch number to `0.31.5`. Suffixes
like `-fixwave` are still allowed as needed (`0.31.1.1-fixwave`), but the
four numeric segments are required first. Historical 3-segment versions
(`0.31.3`, `0.22.1`) remain valid in `git log` and migration filenames
(`skills/migrations/v0.21.0.md`); do NOT rewrite them. Going forward only.

**Required (every release must update all five):**

| File | What lives there | Format |
|---|---|---|
| `VERSION` | The single source of truth. Read first by `/ship`, the binary, and CI version-gate. | Bare 4-segment string `MAJOR.MINOR.PATCH.MICRO` (e.g. `0.31.4.1`), no leading `v`. |
| `package.json` | Bun/npm package version. `gbrain --version` reads it via the compiled binary's bundled package metadata. CI version-gate cross-checks this against `VERSION` and fails if they drift. | `"version": "0.31.4.1"` |
| `CHANGELOG.md` | Top entry header `## [0.31.4.1] - YYYY-MM-DD` plus the "To take advantage of v0.31.4.1" block. | Standard Keep-a-Changelog header. |
| `TODOS.md` | Any TODO entries that mention "follow-up from vX.Y.Z.W" use the version of the release that filed them. Update only when filing NEW follow-up TODOs. | Inline `vX.Y.Z.W` references in TODO bodies. |
| `CLAUDE.md` | The Key Files section's per-file annotations carry `vX.Y.Z.W (#NNN)` tags noting which release introduced a behavior. Update whenever a wave's annotations get folded in. | Inline `vX.Y.Z.W (#NNN, contributed by @user)` references. |

**Auto-derived (no manual edit; refreshed by their own commands):**

- `bun.lock` — root-package version is auto-pinned from `package.json`. After
  bumping `package.json`, run `bun install` to refresh the lockfile.
- `llms-full.txt` / `llms.txt` — auto-generated documentation bundles. **Any
  CLAUDE.md edit MUST be followed by `bun run build:llms` in the same commit
  (or a follow-up commit before push).** The committed bundles are checked
  against fresh generator output by `test/build-llms.test.ts`, which runs in
  CI shard 1. If you edited CLAUDE.md and didn't regenerate, CI will fail.
  This has bitten the wave 3 times — every CLAUDE.md edit gets a `bun run
  build:llms` chaser, no exceptions. (The `verify` gate doesn't run this
  test; only the full unit suite does. So `bun run typecheck` clean is NOT
  enough to know you can push after a CLAUDE.md edit.)

**Historical (DO NOT bump on release):**

- `skills/migrations/v0.21.0.md` — migration files use the version they
  shipped FROM as their filename. v0.21.0's migration always says v0.21.0.
- `src/commands/migrations/v0_21_0.ts` — same: migration code references
  the schema version it migrates to.
- `test/migrations-v0_21_0.test.ts`, `test/migration-orchestrator-v0_21_0.test.ts`,
  `test/migrate.test.ts` — migration tests reference historical migration
  versions; these are correct as-is and should not move.
- `src/core/db.ts`, `src/core/migrate.ts`, `src/core/import-file.ts`,
  `src/commands/reindex-code.ts` — code comments cite the release that
  introduced a feature. Once written, these are historical record.
- `README.md` — references the latest published feature names by version
  (e.g. "v0.21.0 Code Cathedral"); update only when the README's marketing
  copy is intentionally being refreshed, NOT on every micro/patch bump.

**The /ship workflow's version idempotency check:** Step 12 reads
`VERSION` and `package.json`, classifies as FRESH / ALREADY_BUMPED /
DRIFT_STALE_PKG / DRIFT_UNEXPECTED, and refuses to proceed on
DRIFT_UNEXPECTED. This is why the two must move together.

**The CI version-gate** rejects pushes where `VERSION` and
`package.json` disagree, OR where `VERSION` is not strictly greater
than master's VERSION. If a queue collision claims your version on
master before yours lands, /ship's queue-aware allocator (Step 12)
will detect drift and re-bump on the next run.

### Mandatory version-consistency audit (run after EVERY merge or commit that touches VERSION, package.json, or CHANGELOG)

**The trio MUST agree.** Every merge from master will hit conflicts on
VERSION + package.json + CHANGELOG.md because master ships its own
version bumps. Auto-merge sometimes resolves these silently in unexpected
ways. After any merge, branch update, or version-related edit, run this
audit. It's three lines and never lies:

```bash
echo "VERSION:     $(cat VERSION)"
echo "package.json: $(node -e 'process.stdout.write(require("./package.json").version)')"
grep -E "^## \[" CHANGELOG.md | head -1
```

All three MUST show the same `MAJOR.MINOR.PATCH.MICRO`. If any one
disagrees, you have not finished the merge. Fix it before pushing or
shipping. There is no situation in which "I'll fix it next push" is OK,
because:

- A green local test run with mismatched VERSION/package.json still
  fails the CI version-gate.
- A green CHANGELOG entry under the wrong version header silently lies
  to release-notes consumers.
- /ship's Step 12 idempotency check classifies a mismatch as
  `DRIFT_UNEXPECTED` and HALTS — but only if you remember to run /ship
  before pushing. Manual `git push` skips the check.

### Merge-conflict recovery procedure (memorize this)

When `git merge origin/master` reports conflicts on VERSION,
package.json, or CHANGELOG.md, resolve in this exact order:

1. **VERSION** — overwrite with the wave's version (`echo -n "X.Y.Z.W"
   > VERSION`). Highest semver wins; do NOT take master's lower version.
2. **package.json** — strip the conflict markers, keep the wave's
   version line. Sed pattern:
   `sed -i.bak '/^<<<<<<< HEAD$/d; /^=======$/,/^>>>>>>> /d' package.json && rm package.json.bak`
   (assumes ours is above the `=======`).
3. **CHANGELOG.md** — strip ALL three conflict markers; both your entry
   and master's entry stay. Sed pattern:
   `sed -i.bak '/^<<<<<<< HEAD$/d; /^=======$/d; /^>>>>>>> origin\/master$/d' CHANGELOG.md && rm CHANGELOG.md.bak`
   Then verify your entry is the topmost `## [X.Y.Z.W]` and master's
   newer-than-yours entries (if any) sit below.
4. **Run the 3-line audit above.** If it doesn't show your version on
   all three lines, you missed a marker.
5. **Run `bun install`** to refresh `bun.lock` against the resolved
   `package.json`. Stage and commit if it changed.
6. **Run `bun run typecheck`** before committing the merge.
7. Only THEN run `git commit` for the merge.

If the audit shows drift after step 4, do NOT proceed to step 5. Re-run
steps 1-3 against the actual file content; you missed a marker or
resolved one in the wrong direction.

**Anti-pattern to avoid:** Resolving via `git checkout --ours package.json`
and `git checkout --theirs scripts/test-shard.sh` mixed in the same
commit. The selective directional resolution is fine, but on
VERSION/package.json/CHANGELOG specifically, ALWAYS use the explicit
`echo > VERSION` + sed-strip-markers pattern above. The directional
checkout flags have bitten us when the conflict shape was unexpected
(e.g. master stripped a section we expected to keep).

### Pre-push gate (manual; tighten when you remember to)

Before any `git push` of a merge commit, run the audit one more time:

```bash
echo "VERSION:     $(cat VERSION)"
echo "package.json: $(node -e 'process.stdout.write(require("./package.json").version)')"
grep -E "^## \[" CHANGELOG.md | head -1
```

If you've been editing the branch via `/ship` you can rely on Step 12's
idempotency check. If you've been editing manually (merge resolution,
conflict fix, version bump), the audit is the last line of defense
before CI yells at you.

## Conductor branch-name = workspace-name (IRON RULE)

Conductor workspaces expect the git branch name to match the workspace
directory name. When they disagree, Conductor silently fails to render the
PR view + show ship state, leading to "did you actually push?" confusion.

**Check this FIRST on every ship and BEFORE creating any PR:**

```bash
WORKSPACE=$(basename "$PWD")              # e.g. puebla-v4
BRANCH=$(git branch --show-current)        # e.g. garrytan/gstack-requests
case "$BRANCH" in
  */"$WORKSPACE") echo "OK: branch tail matches workspace" ;;
  "$WORKSPACE")   echo "OK: branch == workspace" ;;
  *)              echo "MISMATCH: branch=$BRANCH workspace=$WORKSPACE — RENAME BEFORE SHIPPING" ;;
esac
```

If MISMATCH (branch is `garrytan/foo` but workspace is `puebla-v4`):

```bash
# Rename local, push under new name, delete old remote (and old PR if it
# was already created — github auto-closes it when head ref dies).
git branch -m garrytan/<workspace-name>
git push -u origin garrytan/<workspace-name>
git push origin --delete <old-branch-name>
# If a PR existed against the old branch:
#   gh pr comment <old-pr> --body "Superseded by #<new>: branch renamed to match Conductor workspace."
#   gh pr create --base master --title "..." --body "..."  # recreate from renamed branch
```

Caught the hard way on v0.41.9.0 ship: workspace `puebla-v4` but branch
`garrytan/gstack-requests` produced PR #1439 that Conductor wouldn't
display. Renamed to `garrytan/puebla-v4`; recreated as #1440.

The /ship workflow's Step 1 should be augmented to run the mismatch
check; until that lands upstream, ALWAYS run the check above before
`/ship` invokes its first push or PR-create step.

## Pre-ship requirements

Before shipping (/ship) or reviewing (/review), always run the full test suite.
Two equivalent paths:

**Path A — local CI gate (recommended, v0.23.1+):**
- `bun run ci:local` runs the entire stack inside Docker: gitleaks (host), unit
  tests with `DATABASE_URL` unset, and all 29 E2E files sequentially against a
  fresh pgvector container. Stronger than PR CI's 2-file Tier 1 set; closer to
  what nightly Tier 1 catches. Spins up + tears down postgres automatically via
  `docker-compose.ci.yml`. Override the host port with
  `GBRAIN_CI_PG_PORT=5435 bun run ci:local` if 5434 collides.
- `bun run ci:local:diff` runs only the E2E files matched by the diff selector
  (`scripts/select-e2e.ts`), falling back to all 29 on unmapped src/ paths or
  schema/skills/package.json changes. Fast iteration during a focused branch.

**Path B — manual lifecycle (still supported):**
- `bun test` — unit tests (no database required)
- Follow the "E2E test DB lifecycle" steps above to spin up the test DB,
  run `bun run test:e2e`, then tear it down.

Both must pass. Do not ship with failing E2E tests. Do not skip E2E tests.

**Always run typecheck before pushing.** `bun test` (the bun runner)
skips TypeScript type checking — it only enforces runtime behavior.
Three ways to actually gate on types:

1. `bun run test` (npm script in `package.json`) — includes `bun run typecheck`
   plus the four shell pre-checks (`check-jsonb-pattern.sh`,
   `check-progress-to-stdout.sh`, `check-trailing-newline.sh`,
   `check-wasm-embedded.sh`) before the runner. Use this mid-branch.
2. `bun run typecheck` — `tsc --noEmit` standalone. Fast (~5s on this repo).
3. `bun run ci:local` — the full local CI gate from Path A.

The trap is: writing a new test, running `bun test test/foo.test.ts`,
seeing it pass, pushing — and CI's separate typecheck stage rejects an
invalid type literal that the runner accepted. Caught one of these
shipping the v0.23.2 round-trip E2E (`type: 'reflection'` is not a
member of `PageType`). Run `bun run typecheck` once before push, even
when only test files changed.

## Post-ship requirements (MANDATORY)

After EVERY /ship, you MUST run /document-release. This is NOT optional. Do NOT
skip it. Do NOT say "docs look fine" without running it. The skill reads every .md
file in the project, cross-references the diff, and updates anything that drifted.

If /ship's Step 8.5 triggers document-release automatically, that counts. But if
it gets skipped for ANY reason (timeout, error, oversight), you MUST run it manually
before considering the ship complete.

Files that MUST be checked on every ship:
- README.md — does it reflect new features, commands, or setup steps?
- CLAUDE.md — does it reflect new files, test files, or architecture changes?
- CHANGELOG.md — does it cover every commit?
- TODOS.md — are completed items marked done?
- docs/ — do any guides need updating?

A ship without updated docs is an incomplete ship. Period.

## CHANGELOG + VERSION are branch-scoped

**VERSION and CHANGELOG describe what THIS branch adds vs master, not how we got
here.** Every feature branch that ships gets its own version bump and CHANGELOG
entry. The entry is product release notes for users; it is not a log of internal
decisions, review rounds, or codex findings.

**Write the CHANGELOG entry at /ship time, not during development.** Mid-branch
iterations, review rounds (CEO/Eng/Codex/DX), and implementation detours belong
in the plan file at `~/.claude/plans/`, not in the CHANGELOG. One unified entry
per branch, covering what the branch added vs the base branch.

**Never edit a CHANGELOG entry that already landed on master.** If master has
v0.18.2 and your branch adds features, bump to the next version (v0.19.0, not
editing master's v0.18.2). When merging master into your branch, master may
bring new CHANGELOG entries above yours — push your entry above master's
latest and verify:

- Does CHANGELOG have your branch's own entry separate from master's entries?
- Is VERSION higher than master's VERSION?
- Is your entry the topmost `## [X.Y.Z]` entry?
- `grep "^## \[" CHANGELOG.md` shows a contiguous version sequence?

If any answer is no, fix it before continuing.

**CHANGELOG is for users, not contributors.** Write like product release notes:

- Lead with what the user can now **do** that they couldn't before. Sell the capability.
- Plain language, not implementation details. "You can now..." not "Refactored the..."
- **Never mention internal artifacts**: plan file IDs, decision tags (D-CX-#, F-ENG-#),
  review rounds, codex findings, subcontractor credits. These are invisible to users.
- Put contributor-facing changes in a separate `### For contributors` section at the bottom.
- Every entry should make someone think "oh nice, I want to try that."

**What to omit:**
- "Codex caught X that the CEO review missed" — private process detail.
- "D-CX-3 split errors/warnings" — tag is meaningless to users; name the feature instead.
- "Fix-wave PR #N supersedes #M" — supersede chains belong in PR bodies, not release notes.
- "215 new cases, 3 decisions applied, 7 reviews cleared" — these are planning-mode metrics.

**What to keep:**
- The user-facing change: what commands exist now, what flag was added, what behavior fixed.
- Numbers that mean something to the user: TTHW, commands that timed out before, detection counts.
- Upgrade instructions: `gbrain upgrade` + any manual step if needed.
- Credit to external contributors when a community PR was incorporated.

## CHANGELOG voice + release-summary format

**IRON RULE: the CHANGELOG describes what the user gets, not how the work
happened.** Nobody reading release notes cares that codex caught a bug, that
the plan went through CEO + eng review, that the migration was originally
numbered v68 and renumbered to v79 during master merge, or that two
review rounds caught architectural mistakes. The reader cares what
`gbrain brainstorm` does and how to use it. If a fact only exists because
of the development process, it does NOT belong in the CHANGELOG.

**Specifically forbidden in CHANGELOG entries:**

- Any mention of review processes (CEO review, eng review, codex review,
  plan-eng-review, outside voice, adversarial review, autoplan, /review).
- "What we caught and fixed before merging" sections. Bugs found pre-merge
  are not changes — they're things that didn't ship.
- Plan file references, plan IDs, plan decision tags (D1, D14, D-CDX-3).
- Migration version drama ("originally v68", "renumbered to v77", "claimed
  by parallel waves") — just say "Migration v79 adds X." If the user
  cares about migration ordering, they read the diff.
- Round counts, finding counts, decision counts ("25 findings across 2
  rounds", "8 architectural decisions", "5/6 expansions accepted").
- Names of internal collaborators ("codex caught", "the reviewer flagged",
  "Claude noticed").
- "Plan + reviews" summary bullets. The plan lives in `~/.claude/plans/`;
  if a future reader wants the backstory they can grep there.
- Any wording that frames a shipped feature as a *recovery* from a planning
  mistake ("the first plan was wrong", "we corrected the approach", "the
  shipped version supersedes the original design").

**Smell test:** read the entry as a stranger who has never touched gbrain.
If any sentence makes them think "why are you telling me this?", cut it.
Every sentence in the release-summary AND in the itemized changes must
answer one of three questions: *What can I now do? How do I use it? What
should I watch for after I upgrade?*

Every version entry in `CHANGELOG.md` MUST start with a release-summary section in
the GStack/Garry voice — one viewport's worth of prose + tables that lands like a
verdict, not marketing. The itemized changelog (subsections, bullets, files) goes
BELOW that summary, separated by a `### Itemized changes` header.

The release-summary section gets read by humans, by the auto-update agent, and by
anyone deciding whether to upgrade. The itemized list is for agents that need to
know exactly what changed.

### Release-summary template

**Iron rule: lead ELI10, get precise after.** The first ~150 words of every entry
must be readable by someone who does NOT know gbrain's internals. No file paths,
no function names, no internal constants, no acronyms (no "RRF", no "knobsHash",
no "MODE_BUNDLES", no "CDX-4"), no jargon that requires reading the codebase to
parse. Lead with the user-visible behavior change, in everyday English, like
you're explaining it to a smart engineer who has never opened the repo.

THEN, once the reader knows what shipped and why they'd care, drill into the
precise details: real file paths, real function names, real config keys, real
numbers. The precision part is required (the entry is also the technical record
of what changed), but it lives AFTER the plain-English lead, never before it.

The shape:

1. **One-line bold headline.** What changed for the user, in human English. No
   jargon. No internal terms. Example good: "Your search stops boosting weak
   pages just because they have a lot of links pointing at them." Example bad:
   "PostFusionOpts gains floorRatio; KNOBS_HASH_VERSION bumped 2→3."
2. **Plain-English opener** (~3-5 sentences). Describe the problem this fixes in
   everyday terms. Pretend the reader has a brain full of meeting notes and
   people pages and wants to know if this release helps them. Concrete example
   beats abstract description.
3. **A "How to turn it on" or "How to use it" section** with paste-ready
   commands. Real flags, real config keys. This is where precision starts.
4. **A "What you'd see in a concrete example" or "The X numbers that matter"
   section** with a table. Use everyday-language column headers ("Page",
   "Match quality", "Has many backlinks?") even when the underlying mechanism
   is technical. The table teaches what the feature does without requiring the
   reader to understand how.
5. **A "What's safe to know about" or "Things to watch" section** for caveats,
   side effects, cache invalidation, mid-deploy notes. Still in plain language.
6. **A "What we caught and fixed before merging" section** if the work went
   through review (CEO/eng/codex/outside-voice). Translate review findings into
   plain English. "We caught a stale-cache bug" beats "knobsHash() did not
   include floorRatio in the v=2 hash input."
7. **`### Itemized changes`** (precision lives here). File paths, function
   names, types, constants, line numbers. This section is for engineers who
   need to know exactly what moved.

Voice rules (apply throughout):
- No em dashes (use commas, periods, "...").
- No AI vocabulary (delve, robust, comprehensive, nuanced, fundamental, etc.) or
  banned phrases ("here's the kicker", "the bottom line", etc.).
- Real numbers, real file names, real commands AFTER the ELI10 lead. Not "fast"
  but "~30s on 30K pages." In the ELI10 lead, "fast enough that you won't
  notice" or "~30 seconds even on a big brain."
- Short paragraphs, mix one-sentence punches with 2-3 sentence runs.
- Connect to user outcomes: "the agent does ~3x less reading" beats "improved
  precision."
- Be direct about quality. "Well-designed" or "this is a mess." No dancing.

**The smell test:** if someone who has never opened gbrain reads the first 150
words and walks away knowing what shipped and whether they care, the entry
passes. If they need to grep the codebase to follow along, rewrite the lead.

**Canonical examples in this CHANGELOG:** v0.35.6.0 (floor-ratio gate, written
ELI10-lead-first), v0.34.4.0 (embed stale fix wave). Use those shapes when in
doubt. Avoid the shape of entries that lead with internal constants or release
mechanics; those exist in older history but should not be the model for new
work.

Source material to pull from:
- CHANGELOG.md previous entry for prior context
- Latest `gbrain-evals/docs/benchmarks/[latest].md` for headline numbers (sibling repo)
- Recent commits (`git log <prev-version>..HEAD --oneline`) for what shipped
- Don't make up numbers. If a metric isn't in a benchmark or production data, don't
  include it. Say "no measurement yet" if asked.

Target length: ~250-350 words for the summary. Should render as one viewport.

### "To take advantage of v[version]" block (required, v0.13+)

After the release-summary and BEFORE `### Itemized changes`, every `## [X.Y.Z]`
entry MUST include a human-readable self-repair block under the heading
`## To take advantage of v[version]`.

Why: `gbrain upgrade` runs `gbrain post-upgrade` which runs `gbrain apply-migrations`.
This chain has a known weak link — `upgrade.ts` catches post-upgrade failures as
best-effort (so the binary still works). When that chain silently fails, users end
up with half-upgraded brains. The self-repair block gives them a paste-ready
recovery path; the v0.13+ `~/.gbrain/upgrade-errors.jsonl` trail + `gbrain doctor`
integration close the loop.

Template (adapt the verify commands per release):

```markdown
## To take advantage of v[version]

`gbrain upgrade` should do this automatically. If it didn't, or if `gbrain doctor`
warns about a partial migration:

1. **Run the orchestrator manually:**
   ```bash
   gbrain apply-migrations --yes
   ```
2. **Your agent reads `skills/migrations/v[version].md` the next time you interact with it.**
   [One sentence on whether headless agents need manual action, or whether the
   orchestrator already handled the mechanical side.]
3. **Verify the outcome:**
   ```bash
   [release-specific verify commands, e.g. `gbrain graph ... --depth 2`]
   gbrain stats
   ```
4. **If any step fails or the numbers look wrong,** please file an issue:
   https://github.com/garrytan/gbrain/issues with:
   - output of `gbrain doctor`
   - contents of `~/.gbrain/upgrade-errors.jsonl` if it exists
   - which step broke

   This feedback loop is how the gbrain maintainers find fragile upgrade paths. Thank you.
```

**Skip this block** for patches that are pure bug fixes with zero user-facing action
(rare). If the release has a schema migration, data backfill, or new feature the
user needs to verify, the block is required.

The v0.13.0 entry in CHANGELOG.md is the canonical example.

### Itemized changes (the existing rules)

Below the release summary, write `### Itemized changes` and continue with the
detailed subsections (Knowledge Graph Layer, Schema migrations, Security hardening,
Tests, etc.). Same rules as before:

- Lead with what the user can now DO that they couldn't before
- Frame as benefits and capabilities, not files changed or code written
- Make the user think "hell yeah, I want that"
- Bad: "Added GBRAIN_VERIFY.md installation verification runbook"
- Good: "Your agent now verifies the entire GBrain installation end-to-end, catching
  silent sync failures and stale embeddings before they bite you"
- Bad: "Setup skill Phase H and Phase I added"
- Good: "New installs automatically set up live sync so your brain never falls behind"
- **Always credit community contributions.** When a CHANGELOG entry includes work from
  a community PR, name the contributor with `Contributed by @username`. Contributors
  did real work. Thank them publicly every time, no exceptions.

### Reference: v0.12.0 entry as canonical example

The v0.12.0 entry in CHANGELOG.md is the canonical example of the format. Match its
structure for every future version: bold headline, lead paragraph, "numbers that
matter" with BrainBench-style before/after table, "what this means" closer, then
`### Itemized changes` with the detailed sections below.

## Version migrations

Create a migration file at `skills/migrations/v[version].md` when a release
includes changes that existing users need to act on. The auto-update agent
reads these files post-upgrade (Section 17, Step 4) and executes them.

**You need a migration file when:**
- New setup step that existing installs don't have (e.g., v0.5.0 added live sync,
  existing users need to set it up, not just new installs)
- New SKILLPACK section with a MUST ADD setup requirement
- Schema changes that require `gbrain init` or manual SQL
- Changed defaults that affect existing behavior
- Deprecated commands or flags that need replacement
- New verification steps that should run on existing installs
- New cron jobs or background processes that should be registered

**You do NOT need a migration file when:**
- Bug fixes with no behavior changes
- Documentation-only improvements (the agent re-reads docs automatically)
- New optional features that don't affect existing setups
- Performance improvements that are transparent

**The key test:** if an existing user upgrades and does nothing else, will their
brain work worse than before? If yes, migration file. If no, skip it.

Write migration files as agent instructions, not technical notes. Tell the agent
what to do, step by step, with exact commands. See `skills/migrations/v0.5.0.md`
for the pattern.

## Migration is canonical, not advisory

GBrain's job is to deliver a canonical, working setup to every user on upgrade.
Anything that looks like a "host-repo change" — AGENTS.md, cron manifests,
launchctl units, config files outside `~/.gbrain/` — is a GBrain migration
step, not a nudge we leave for the host-repo maintainer. Migrations edit host
files (with backups) to make the canonical setup real. Exceptions: changes
that require human judgment (content edits, renames that break semantics,
host-specific handler registration where shell-exec would be an RCE surface).
Everything mechanical ships in the migration.

**Test:** if shipping a feature requires a sentence that starts with "in
your AGENTS.md, add…" or "in your cron/jobs.json, rewrite…", the migration
orchestrator should be doing that edit, not the user.

**The exception is host-specific code.** For custom Minion handlers
(host-specific integrations like inbox sweeps or third-party API scanners), shipping them as a
data file the worker would exec is an RCE surface. Those get registered in
the host's own repo via the plugin contract (`docs/guides/plugin-handlers.md`);
the migration orchestrator emits a structured TODO to
`~/.gbrain/migrations/pending-host-work.jsonl` + the host agent walks the
TODOs using `skills/migrations/v0.11.0.md` — stays host-agnostic, still
canonical.


## Schema state tracking

`~/.gbrain/update-state.json` tracks which recommended schema directories the user
adopted, declined, or added custom. The auto-update agent (SKILLPACK Section 17)
reads this during upgrades to suggest new schema additions without re-suggesting
things the user already declined. The setup skill writes the initial state during
Phase C/E. Never modify a user's custom directories or re-suggest declined ones.

## GitHub Actions SHA maintenance

All GitHub Actions in `.github/workflows/` are pinned to commit SHAs. Before shipping
(`/ship`) or reviewing (`/review`), check for stale pins and update them:

```bash
for action in actions/checkout oven-sh/setup-bun actions/upload-artifact actions/download-artifact softprops/action-gh-release gitleaks/gitleaks-action; do
  tag=$(grep -r "$action@" .github/workflows/ | head -1 | grep -o '#.*' | tr -d '# ')
  [ -n "$tag" ] && echo "$action@$tag: $(gh api repos/$action/git/ref/tags/$tag --jq .object.sha 2>/dev/null)"
done
```

If any SHA differs from what's in the workflow files, update the pin and version comment.

## PR descriptions cover the whole branch

Pull request titles and bodies must describe **everything in the PR diff against the
base branch**, not just the most recent commit you made. When you open or update a
PR, walk the full commit range with `git log --oneline <base>..<head>` and write the
body to cover all of it. Group by feature area (schema, code, tests, docs) — not
chronologically by commit.

This matters because reviewers read the PR body to understand what's shipping. If
the body only covers your last commit, they miss everything else and can't review
properly. A 7-commit PR with a body that describes commit 7 is worse than no body
at all — it actively misleads.

When in doubt, run `gh pr view <N> --json commits --jq '[.commits[].messageHeadline]'`
to see what's actually in the PR before writing the body.

## Community PR wave process

Never merge external PRs directly into master. Instead, use the "fix wave" workflow:

1. **Categorize** — group PRs by theme (bug fixes, features, infra, docs)
2. **Deduplicate** — if two PRs fix the same thing, pick the one that changes fewer
   lines. Close the other with a note pointing to the winner.
3. **Collector branch** — create a feature branch (e.g. `garrytan/fix-wave-N`), cherry-pick
   or manually re-implement the best fixes from each PR. Do NOT merge PR branches directly —
   read the diff, understand the fix, and write it yourself if needed.
4. **Test the wave** — verify with `bun test && bun run test:e2e` (full E2E lifecycle).
   Every fix in the wave must have test coverage.
5. **Close with context** — every closed PR gets a comment explaining why and what (if
   anything) supersedes it. Contributors did real work; respect that with clear communication
   and thank them.
6. **Ship as one PR** — single PR to master with all attributions preserved via
   `Co-Authored-By:` trailers. Include a summary of what merged and what closed.

**Community PR guardrails:**
- Always AskUserQuestion before accepting commits that touch voice, tone, or
  promotional material (README intro, CHANGELOG voice, skill templates).
- Never auto-merge PRs that remove YC references or "neutralize" the founder perspective.
- Preserve contributor attribution in commit messages.

## Checking out PRs from garrytan-agents

`garrytan-agents` is the AI-authored PR account and is NOT a collaborator on
this repo. Its PRs live in a fork, so GitHub Actions triggered by
`pull_request` events on those PRs do not receive base-repo secrets. Any CI
job that needs `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, or similar will fail
with empty-env auth errors, regardless of what's set on the base repo. This
is a GitHub security default, not a config bug.

When the user says "check out <PR link>" and the PR is from `garrytan-agents`
(or any other non-collaborator fork), move the branch into the base repo
before running CI:

1. `gh pr checkout <N>` — pull down the fork's branch. Note the PR number and
   head branch name (`gh pr view <N> --json headRefName --jq .headRefName`).
2. `git push origin HEAD:<branch-name>` — push the same branch to the base
   repo (origin points at `garrytan/gbrain`, not the fork). This is the move
   that gives CI access to secrets.
3. `gh pr close <N> --comment "moving to base-repo branch for secret access"`
   — close the fork PR so the queue stays clean.
4. `gh pr create --base master --head <branch-name>` — open the replacement
   PR from the base-repo branch. **Preserve the original PR's title and body
   verbatim** (`gh pr view <N> --json title,body`); contributor attribution
   moves to a `Co-Authored-By:` trailer if needed.

Why this over alternatives: adding `garrytan-agents` as a collaborator, or
flipping the repo-wide "send secrets to fork PRs" toggle, both broaden
secret distribution to every fork PR from that account or any fork. Moving
the branch keeps secret scope tight to just the one PR being shipped.

