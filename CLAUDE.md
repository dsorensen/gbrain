# CLAUDE.md

GBrain is a personal knowledge brain and GStack mod for agent platforms. Pluggable
engines: PGLite (embedded Postgres via WASM, zero-config default) or Postgres + pgvector
+ hybrid search in a managed Supabase instance. `gbrain init` defaults to PGLite;
suggests Supabase for 1000+ files. GStack teaches agents how to code. GBrain teaches
agents everything else: brain ops, signal detection, content ingestion, enrichment,
cron scheduling, reports, identity, and access control.

## Two organizational axes (read this first)

GBrain knowledge is organized along two orthogonal axes. Users AND agents must
understand both, or queries misroute silently.

- **Brain** — WHICH DATABASE. Your personal brain is `host`. You can mount
  additional brains (team-published, each with their own DB and access policy)
  via `gbrain mounts add` (v0.19+). Routing: `--brain`, `GBRAIN_BRAIN_ID`,
  `.gbrain-mount` dotfile.
- **Source** — WHICH REPO INSIDE THE DATABASE. A brain can hold many sources
  (wiki, gstack, openclaw, essays). Slugs scope per source. Routing:
  `--source`, `GBRAIN_SOURCE`, `.gbrain-source` dotfile.

Both axes follow the same 6-tier resolution pattern. Read
`docs/architecture/brains-and-sources.md` for topology diagrams (personal, team
mount, CEO-class with multiple team brains) and
`skills/conventions/brain-routing.md` for the agent-facing decision table.

## Architecture

Contract-first: `src/core/operations.ts` defines ~47 shared operations (v0.29 adds `get_recent_salience`, `find_anomalies`, `get_recent_transcripts`). CLI and MCP
server are both generated from this single source. Engine factory (`src/core/engine-factory.ts`)
dynamically imports the configured engine (`'pglite'` or `'postgres'`). Skills are fat
markdown files (tool-agnostic, work with both CLI and plugin contexts).

**Trust boundary:** `OperationContext.remote` distinguishes trusted local CLI callers
(`remote: false` set by `src/cli.ts`) from untrusted agent-facing callers
(`remote: true` set by `src/mcp/server.ts`). Security-sensitive operations like
`file_upload` tighten filesystem confinement when `remote=true` and default to
strict behavior when unset.

## Key files

> Terse map of the architectural spine. The **full** per-file contract reference (every module — exports, flags, invariants) lives in `docs/architecture/key-files.md`. Per-version history (PR numbers, decision tags, migration lineage) is archived verbatim in `docs/architecture/key-files-history.md`. Neither is loaded into agent context — read them (or the code) when you touch a specific file.

**Contract + engines**
- `src/core/operations.ts` — contract-first definitions for the ~74 shared operations; CLI and MCP are generated from it. Carries scope/`localOnly` annotations, the trust boundary (`OperationContext.remote`), and `sourceScopeOpts(ctx)` (source-scoping precedence ladder).
- `src/core/engine.ts` — `BrainEngine` interface (`kind: 'postgres' | 'pglite'`), `SearchOpts` / `PageFilters`, batch + delete primitives.
- `src/core/engine-factory.ts` — dynamic engine selection (`'pglite'` | `'postgres'`).
- `src/core/pglite-engine.ts` / `src/core/postgres-engine.ts` — the two engine implementations.
- `src/core/db.ts` — connection management, schema init, session timeouts.
- `src/core/migrate.ts` — schema-migration runner + the `MIGRATIONS` array (DDL source of truth).
- `src/commands/migrations/` — TS migration registry compiled into the binary.

**Ingest + sync**
- `src/core/import-file.ts` — `importFromFile` / `importFromContent`: the narrow waist every ingest path passes through (sanity gate → chunk → embed → tags).
- `src/core/sync.ts` — pure sync functions (manifest parsing, filtering, slug conversion, error classification).
- `src/commands/sync.ts` — `gbrain sync` + the `performSync` writer-lock entrypoint.
- `src/commands/import.ts` — `gbrain import` + checkpointed `runImport`.
- `src/core/markdown.ts` — frontmatter parsing, body/timeline splitter, `inferType`.

**Search + AI**
- `src/core/search/hybrid.ts` — hybrid search (vector + keyword + RRF + post-fusion boost stages).
- `src/core/search/mode.ts` — named search modes (`conservative` / `balanced` / `tokenmax`), knob resolution, cache-key hash.
- `src/core/ai/gateway.ts` — unified seam for every chat / embed / rerank call; budget tracker; provider recipes.
- `src/core/model-config.ts` — model-string resolution (4-tier system; subagent-Anthropic guard).

**MCP + serving + auth**
- `src/cli.ts` — CLI entrypoint, op dispatch, thin-client routing seam.
- `src/mcp/server.ts` + `src/mcp/dispatch.ts` — stdio MCP server; shared tool-call dispatch (context build, validation, trust default).
- `src/commands/serve-http.ts` — HTTP MCP server with OAuth 2.1 + admin dashboard.
- `src/core/oauth-provider.ts` — OAuth 2.1 provider (PKCE, client_credentials, refresh rotation); source-scoped tokens.

**Jobs (Minions) + cycle**
- `src/core/minions/queue.ts` + `src/core/minions/worker.ts` — Postgres-native job queue + worker (lock renewal, stall detection, timeouts).
- `src/core/minions/handlers/subagent.ts` — LLM-loop subagent handler.
- `src/core/cycle.ts` — brain-maintenance cycle (lint → backlinks → sync → synthesize → extract → patterns → recompute_emotional_weight → embed → orphans → purge).

**Ops + config + skills**
- `src/commands/doctor.ts` — `gbrain doctor` health checks + `--fix` / `--remediate`.
- `src/core/config.ts` — config load/save; `gbrainPath()` (honors `GBRAIN_HOME`).
- `src/core/cli-options.ts` — global flag parser; `maybeBackground()`.
- `src/core/progress.ts` — shared bulk-action progress reporter (writes to stderr).
- `src/core/source-resolver.ts` — 6-tier source resolution.
- `skills/RESOLVER.md` + `skills/_brain-filing-rules.md` — skill routing table + cross-cutting filing rules.

**Public API surface** — the `package.json` exports map is what the sibling `gbrain-evals` repo consumes; removing any export is a breaking change. Full list in `docs/architecture/key-files.md`.

## Commands

Run `gbrain --help` or `gbrain --tools-json` for full command reference.

Key commands added in v0.7:
- `gbrain init` — defaults to PGLite (no Supabase needed), scans repo size, suggests Supabase for 1000+ files
- `gbrain migrate --to supabase` / `gbrain migrate --to pglite` — bidirectional engine migration

Key commands added for Minions (job queue):
- `gbrain jobs submit <name> [--params JSON] [--follow] [--dry-run]` — submit a background job. v0.13.1 adds first-class flags for every `MinionJobInput` tuning knob: `--max-stalled N`, `--backoff-type fixed|exponential`, `--backoff-delay Nms`, `--backoff-jitter 0..1`, `--timeout-ms N`, `--idempotency-key K`.
- `gbrain jobs list [--status S] [--queue Q]` — list jobs with filters
- `gbrain jobs get <id>` — job details with attempt history
- `gbrain jobs cancel/retry/delete <id>` — manage job lifecycle
- `gbrain jobs prune [--older-than 30d]` — clean old completed/dead jobs
- `gbrain jobs stats` — job health dashboard
- `gbrain jobs smoke [--sigkill-rescue]` — health smoke test. `--sigkill-rescue` is the v0.13.1 regression guard for #219: simulates a killed worker and asserts the stalled job is requeued instead of dead-lettered on first stall.
- `gbrain jobs work [--queue Q] [--concurrency N]` — start worker daemon (Postgres only)

Key commands added in v0.40.3.0 (contextual retrieval + cache gate + 4 CLI verbs):
- `gbrain mounts enable <id>` / `disable <id>` — toggle a mount without removing it.
- `gbrain mounts trust-frontmatter <id>` / `untrust-frontmatter <id>` — let a mounted brain's per-page `contextual_retrieval_mode` frontmatter override the source default. Off by default for mounts (security posture per D15); host source is always trusted.
- `gbrain sources set-cr-mode <id> <none|title|per_chunk_synopsis>` — per-source contextual retrieval mode override. Pass `unset` or `default` to clear (NULL falls through to global). Missing source ID fails loudly with paste-ready `gbrain sources list` hint.
- `gbrain config set search.mode tokenmax` triggers a mode-switch banner explaining the per-chunk Haiku synopsis backfill cost, and (on TTY + active Minion worker) offers to submit `gbrain reindex --markdown` as a Minion job. Non-TTY callers get a paste-ready hint to stderr instead of a silent stall. Suppress with `GBRAIN_NO_MODE_SWITCH_UX=1` for CI fixtures.
- Cache invalidation gate is now two-layer (per D11 codex finding): Layer 1 cheap MAX(generation) bookmark via `pages_generation_idx`, Layer 2 per-page snapshot via jsonb_each + LEFT JOIN pages. Pre-v0.40.3.0 cache rows with empty `{}` snapshot are vacuously valid (IRON-RULE backward compat).
- KNOBS_HASH_VERSION bumped 3 → 5 (skipped past 4 reserved by salem's v0.40.4 graph-signals work). One-time cache-row invalidation on upgrade; refills within TTL.
- Three new Minion handlers wired into RemediationStep consumer pattern: `lint-fix`, `integrity-auto`, `sync-retry-failed`. Thin wrappers around already-shipping CLI commands; NOT in PROTECTED_JOB_NAMES (idempotent, no shell exec, MCP-safe). `sync-skip-failed` deliberately NOT in this set per codex D12 Bug 3.
- `src/core/remediation-step.ts` (NEW canonical module) exports RemediationStep type + makeRemediationStep factory + canonical-JSON idempotencyKey() per codex D12 Bug 2. Future doctor checks emit RemediationSteps via the factory instead of hand-rolling the shape.
- `src/core/search/query-cache-gate.ts` (NEW) exports `buildPageGenerationsSnapshot(engine, pageIds)` + `CACHE_GATE_WHERE_CLAUSE` SQL fragment + `validateCacheRowAgainstPages()` pure validator. **v0.41.25.0 (codex outside-voice on /plan-eng-review):** Layer 1 bookmark read source switched from `MAX(generation) FROM pages` to `SELECT value FROM page_generation_clock WHERE id = 1` at both store + lookup sites. Closes two pre-existing silent stale-cache bug classes that were independent of any sync work: (1) CDX-2 — UPDATE to a non-max page set `NEW.generation = OLD.generation + 1` which didn't advance MAX, so cache silently served stale on every non-max UPDATE; (2) CDX-1 — DELETE didn't fire the row-level trigger at all, and even an AFTER DELETE wouldn't move MAX because surviving rows are untouched. The new clock is bumped per-statement by `bump_page_generation_clock_trg` (statement-level trigger created in migration v106) so every INSERT/UPDATE/DELETE statement advances the bookmark exactly once regardless of row cardinality (D19 — per-row would turn a 73K-row batch DELETE into 73K UPDATEs on the same counter). Also CDX-6/D20 fix: empty-result cache rows used to be "vacuously valid" via Layer 2's `qc.page_generations = '{}'::jsonb` shortcut, silently serving stale empty results across subsequent matching INSERTs. The shortcut is gone — empty snapshots now require Layer 1 to pass. `CACHE_GATE_WHERE_CLAUSE` enforces `qc.page_generations <> '{}'::jsonb` AND the per-page check (not OR). One-time post-upgrade cache miss spike on legacy `{}` rows is acceptable — the cache fills back up correctly and the clock seed `COALESCE(MAX(pages.generation), 0)` keeps non-empty legacy rows serving until the next write. Pinned by 5 new cases in `test/page-generation-counter.test.ts` (CDX-1/CDX-2/CDX-6 regressions + statement-level-trigger-fires-once contract) and 2 new e2e cases in `test/e2e/cache-gate-pglite.test.ts`. The existing pre-v0.41.25.0 `vacuously valid legacy row` IRON-RULE assertion in both files is intentionally inverted: that path was the CDX-6 bug.
- `src/core/search/mode-switch-ux.ts` (NEW) exports `summarizeTransition()` 5-cell matrix + `probeWorkerAvailable()` worker liveness proxy via minion_jobs activity + `buildReindexIdempotencyKey()` content-stable key + `runModeSwitchUx()` orchestrator.

Key commands added in v0.36.4.0 (brain-health-100 wave):
- `gbrain doctor --remediation-plan [--target-score N] [--json]` — preview the dependency-ordered plan that would drive the brain to target. JSON envelope is stable: each `Remediation` carries `id`, `idempotency_key` (content-hash for cron-safe retries), `severity`, `est_seconds`, `est_usd_cost`, and `depends_on` (referencing other ids). Empty `recommendations` array when the brain is already at target.
- `gbrain doctor --remediate [--yes] [--target-score N] [--max-usd N]` — actually submit the plan. Walks dependency order, submits one Minion job per step, re-checks score between steps, refuses to spend past `--max-usd` (defaults: target=90, max-usd=infinite — but cron callers should always pass `--max-usd`). Bails when target exceeds `maxReachableScore()` for the brain (empty / under-configured brains) with a clear list of what's missing.
- `gbrain embed --stale --background` — submit the embed sweep as a Minion job; print `job_id=N` to stdout; exit. Composable in shell pipelines. Add `--background --follow` to attach to the job's stderr stream (same UX as a direct call).
- Eleven new Minion job types submittable via `gbrain jobs submit <name>`: `reindex`, `repair-jsonb`, `orphans`, `integrity`, `purge`, `synthesize` (PROTECTED), `patterns` (PROTECTED), `consolidate` (PROTECTED), `extract_facts`, `resolve_symbol_edges`, `recompute_emotional_weight`. PROTECTED ones reject MCP submission and require `--allow-protected` from a trusted local caller (CLI, autopilot, `doctor --remediate`).
- `gbrain autopilot` (existing daemon) is now health-aware. Tick cost on a healthy brain drops from "full 6-phase cycle every 5 minutes" to "one SQL count, then sleep". Degraded brains get targeted handlers (`[sync]`, `[embed]`, `[backlinks]`) instead of the full cycle when the plan is small; large plans still get `autopilot-cycle`. The "60-minute full-cycle floor" runs the full phase set on a healthy brain at least every hour so phase-coupling invariants (lint-first, synthesize-before-patterns, embed-after-consolidate) keep getting exercised.

Key commands added in v0.32.7 (CJK fix wave):
- `gbrain reindex --markdown [--limit N] [--dry-run] [--json] [--no-embed] [--repo PATH]` — operator-facing markdown re-chunk sweep. Walks pages with `chunker_version < MARKDOWN_CHUNKER_VERSION` (currently 2) and re-imports each with `forceRechunk: true` so the new chunker shape actually applies. Run automatically by `gbrain upgrade`'s post-upgrade hook; available manually for triage.
- `gbrain doctor` learns a new `slug_fallback_audit` check: surfaces info-severity entries from `~/.gbrain/audit/slug-fallback-YYYY-Www.jsonl` (last 7 days) as an `ok` count when CJK / emoji / exotic-script filenames imported via the frontmatter-slug fallback path.
- `gbrain search "<CJK substring>"` on PGLite brains now uses an `ILIKE`-based fallback with bigram-frequency-count ranking when the query contains Han / Hiragana / Katakana / Hangul Syllables. ASCII queries continue through `websearch_to_tsquery('english')` unchanged. Postgres-side CJK FTS still requires an extension (pgroonga / zhparser) — see v0.33+ TODO.
- `gbrain upgrade` post-upgrade flow now prints a cost estimate before re-embedding: `[chunker-bump] Will re-embed ~N markdown pages via <provider:model>, est. ~$X.XX, ~Ymin. Press Ctrl-C within 10s to abort.` Sourced from real SQL counts + char totals; TTY-only wait (non-TTY auto-proceeds for CI / cron). Env overrides: `GBRAIN_NO_REEMBED=1` bails out entirely with a doctor-warning marker; `GBRAIN_REEMBED_GRACE_SECONDS=0` skips the wait.

Key commands added in v0.33.1.1 (Voyage 2048-dim correctness wave):
- `gbrain models doctor` learns a new zero-token `embedding_config` probe that runs FIRST, before any chat/expansion probes spend money. Catches Voyage flexible-dim misconfigs at config time, not first-embed: `embedding_model: voyage:voyage-4-large` with `embedding_dimensions` outside `{256, 512, 1024, 2048}` (most commonly: `embedding_dimensions` left unset, falling back to the OpenAI default 1536 which Voyage rejects with an opaque HTTP 400). Surfaces a paste-ready `gbrain config set embedding_dimensions <256|512|1024|2048>` fix in both human and JSON output. New probe status `'config'` joins `{ok, model_not_found, auth, rate_limit, network, unknown}`; new touchpoint label `'embedding_config'` joins `'chat'` and `'expansion'`.
- Voyage 2048-dim brains now actually embed at 2048 dims. `embedding_model: voyage:voyage-4-large` + `embedding_dimensions: 2048` routes through the SDK-supported `dimensions` field, which `voyageCompatFetch` translates to Voyage's `output_dimension` on the wire. Same fix covers `voyage-3-large`, `voyage-3.5`, `voyage-3.5-lite`, `voyage-4`, `voyage-4-lite`, `voyage-code-3`. `voyage-4-nano` (open-weight, fixed 1024-dim) intentionally NOT in the flexible-dim allowlist — sending `output_dimension` to nano's endpoint produces an error.
- Runtime validator: `dimsProviderOptions()` throws `AIConfigError` at the embed boundary with a paste-ready fix hint when a Voyage flexible-dim model is configured with an invalid dim — fail-loud even if you skipped `gbrain models doctor`.
- `VoyageResponseTooLargeError` (new tagged class exported from `src/core/ai/gateway.ts`): the 256 MB per-response cap inside `voyageCompatFetch` was previously throwing a generic `Error` that the surrounding parse-error try/catch silently swallowed, returning the oversized response to the AI SDK anyway. Now thrown at both cap sites (Content-Length Layer 1, per-embedding base64 Layer 2) and rethrown from the catch via `instanceof` check — the cap is now actually effective.

Key commands added in v0.31.12 (model tier system + routing CLI):
- `gbrain models [--json]` — read-only routing dashboard. Prints the four tier defaults (`utility`/`reasoning`/`deep`/`subagent`), the resolved value for each (after re-walking `models.default` → `models.tier.<tier>` → env → `TIER_DEFAULTS`), every per-task override (`models.dream.synthesize`, `models.dream.patterns`, `models.drift`, `models.auto_think`, `models.think`, `models.subagent`, `facts.extraction_model`, `models.eval.longmemeval`, `models.expansion`, `models.chat`, `models.dream.synthesize_verdict`), the alias map (defaults + user overrides), and a source-of-truth column (`default` / `config: <key>` / `env: <VAR>`).
- `gbrain models doctor [--skip=<provider>] [--json]` — 1-token reachability probe against each configured chat + expansion model. Classifies failures into `{model_not_found, auth, rate_limit, network, unknown}`. The structural fix for the bug class that motivated v0.31.12 (v0.31.6's `claude-sonnet-4-6-20250929` chat default 404'd silently on every install).
- Power-user model routing via config keys:
  - `gbrain config set models.default opus` — route every internal call (chat, expansion, synthesis, classification) through Opus 4.7. Subagent loop still falls back to `claude-sonnet-4-6` automatically (Anthropic-only by construction).
  - `gbrain config set models.tier.<tier> <model>` — override one tier independently (`utility` / `reasoning` / `deep` / `subagent`).
  - `gbrain config set models.aliases.frontier anthropic:claude-opus-4-7` — define an alias, then `gbrain config set models.default frontier`.
  - Per-task keys (e.g. `gbrain config set models.dream.synthesize <model>`) still beat tier overrides because they are more specific.
- New `subagent_provider` check in `gbrain doctor` surfaces config drift if `models.tier.subagent` or `models.default` would route the Anthropic Messages API tool-loop to a non-Anthropic provider.
- The skill at `skills/conventions/model-routing.md` was rewritten to cover both the new tier system AND the existing subagent spawn routing in one canonical doc (power-user recipes, three-layer enforcement explanation, override priority chain).

Key commands added in v0.28.1 (LongMemEval in the box):
- `gbrain eval longmemeval <dataset.jsonl>` — run the public LongMemEval benchmark against gbrain hybrid retrieval. Flags: `--limit N`, `--model M`, `--retrieval-only`, `--keyword-only`, `--expansion`, `--top-k K`, `--output FILE`. One in-memory PGLite per benchmark run; `TRUNCATE` between questions over runtime-enumerated `pg_tables` (schema-migration-safe); `~/.gbrain` never opened. `--expansion` defaults OFF (deterministic, no per-query Haiku). Default model resolves through `resolveModel()` 6-tier chain with new `models.eval.longmemeval` config key. `gbrain eval longmemeval --help` works without a configured brain (hermeticity gate).
- Sanitization parity with takes: `INJECTION_PATTERNS` exported from `src/core/think/sanitize.ts`. The benchmark harness re-uses the same pattern set so adding a new injection pattern automatically covers takes AND benchmarks.
- Hand the resulting JSONL to LongMemEval's published `evaluate_qa.py` to score (not bundled — needs OpenAI gpt-4o per their spec). Dataset: https://huggingface.co/datasets/xiaowu0162/longmemeval.

Key commands added in v0.26.5 (destructive-guard, end-to-end):
- `gbrain sources archive <id>` — soft-delete a source. Hides from search via the new `sources.archived` column + cascading visibility filter. Preserves data for 72h. (PR #595 cherry-pick.)
- `gbrain sources restore <id> [--no-federate]` — un-archive a soft-deleted source. Re-federates by default.
- `gbrain sources archived [--json]` — list soft-deleted sources with their TTL.
- `gbrain sources purge [<id>] [--confirm-destructive]` — permanent delete; with no id, purges all sources whose TTL expired.
- `gbrain sources remove <id> [--confirm-destructive] [--dry-run]` — `--yes` alone no longer enough on populated sources. Boxed impact preview before destruction.
- `gbrain pages purge-deleted [--older-than HOURS|Nd] [--dry-run] [--json]` — operator escape hatch for page-level soft-delete cleanup. Mirror of `gbrain sources purge`. The autopilot cycle's new `purge` phase calls the same library function automatically every run.
- MCP `delete_page` op semantically shifts from hard-delete to soft-delete. New ops: `restore_page` (`scope: write`), `purge_deleted_pages` (`scope: admin`, `localOnly: true`).
- `get_page` and `list_pages` extended with `include_deleted: boolean` (default false).
- New autopilot cycle phase `purge` (9th, runs after `orphans`). `gbrain dream --phase purge` runs only the purge sweep.
- Index strategy note: the partial index `pages_deleted_at_purge_idx ON pages (deleted_at) WHERE deleted_at IS NOT NULL` supports the autopilot purge query. Search filters (`WHERE deleted_at IS NULL`) do NOT need their own index — soft-deleted cardinality stays low and Postgres won't use the partial index for the negative predicate. Don't add a regular `(deleted_at)` index without measuring.
- Schema migration v34 (`destructive_guard_columns`) adds `pages.deleted_at` + the partial purge index; promotes `archived` from `sources.config` JSONB to real columns; backfills any pre-v0.26.5 JSONB shape.

Key commands added in v0.25.0:
- `gbrain eval export [--since DUR] [--limit N] [--tool query|search]` — stream captured `eval_candidates` rows as NDJSON to stdout. Every line starts with `"schema_version": 1` per the stable contract in `docs/eval-capture.md`. EPIPE-safe, progress heartbeats on stderr, deterministic ordering. Primary consumer is the sibling `gbrain-evals` repo for BrainBench-Real replay.
- `gbrain eval prune --older-than DUR [--dry-run]` — explicit retention cleanup for `eval_candidates`. Requires `--older-than` (never deletes without a window). Duration strings: 30d, 7d, 1h, 90m, 3600s.
- `gbrain eval replay --against FILE.ndjson [--limit N] [--top-regressions K] [--json] [--verbose]` — contributor-facing dev loop. Reads a captured NDJSON snapshot, re-runs each `query` / `search` op against the current brain, computes mean set-Jaccard@k between captured + current `retrieved_slugs`, top-1 stability rate, and latency Δ. JSON mode (`schema_version: 1`) for CI gating; human mode prints a regression table sorted worst-first. Closes the gap between "data captured" and "data used to gate a PR." See `docs/eval-bench.md` for the workflow.
- `gbrain eval cross-modal --task "..." --output <path> [--cycles N] [--slot-a-model ID] [--slot-b-model ID] [--slot-c-model ID] [--receipt-dir DIR] [--json]` (v0.27.x) — multi-model quality gate. Three different-provider frontier models score the OUTPUT against the TASK on 5 documented dimensions. Pass criterion: every dim mean >=7 AND no model scored any dim <5. Exit codes: 0 PASS, 1 FAIL, 2 INCONCLUSIVE (<2/3 models returned parseable scores). Default cycles=3 in TTY, **cycles=1 in non-TTY** (limits accidental scripted bulk spend). Default slots: `openai:gpt-4o` / `anthropic:claude-opus-4-7` / `google:gemini-1.5-pro` — refresh alongside model-family bumps. Receipts land at `~/.gbrain/.gbrain/eval-receipts/<slug>-<sha8-of-output>.json` (gbrainPath honors GBRAIN_HOME). Bypasses `connectEngine()` via the cli.ts no-DB branch — runs cleanly before `gbrain init`. Reuses `src/core/ai/gateway.ts:chat()` for config/auth (no parallel provider stack). Cost-estimate prints to stderr before each cycle (T11=B partial cost guardrail; full `--budget-usd N` is a follow-up TODO).
- `gbrain doctor` gains an `eval_capture` check: reads `eval_capture_failures` for the last 24h, groups by reason, warns when non-zero. Cross-process visibility (doctor runs in a separate process from MCP). Pre-v31 brains get `Skipped (table unavailable)` — non-fatal.
- Config addition: `eval: { capture?: boolean, scrub_pii?: boolean }` in `~/.gbrain/config.json`. **File-plane only** — `gbrain config set` writes the DB plane and does NOT control capture.
- **`GBRAIN_CONTRIBUTOR_MODE=1` env var** is the contributor-facing toggle. Capture is **off by default** as of v0.25.0; production users get a quiet brain. Resolution order: explicit `eval.capture` config wins both directions, then env var, then off. Documented in README.md, CONTRIBUTING.md, and `docs/eval-bench.md`.

Key commands added in v0.12.2:
- `gbrain repair-jsonb [--dry-run] [--json]` — repair double-encoded JSONB rows left over from v0.12.0-and-earlier Postgres writes. Idempotent; PGLite no-ops. The `v0_12_2` migration runs this automatically on `gbrain upgrade`.

Key commands added in v0.12.3:
- `gbrain orphans [--json] [--count] [--include-pseudo]` — surface pages with zero inbound wikilinks, grouped by domain. Auto-generated/raw/pseudo pages filtered by default. Also exposed as `find_orphans` MCP operation. The natural consumer of the v0.12.0 knowledge graph layer: once edges are captured, find the gaps.
- `gbrain doctor` gains two new reliability detection checks: `jsonb_integrity` (v0.12.0 Postgres double-encode damage) and `markdown_body_completeness` (pages truncated by the old splitBody bug). Detection only; fix hints point at `gbrain repair-jsonb` and `gbrain sync --force`.

Key commands added in v0.14.2:
- `gbrain sync --skip-failed` — acknowledge the current set of failed-parse files recorded in `~/.gbrain/sync-failures.jsonl` so the sync bookmark advances past them. Doctor's `sync_failures` check shows previously-skipped as "all acknowledged" instead of warning.
- `gbrain sync --retry-failed` — re-walk the unacknowledged failures and re-attempt parsing. If the files now succeed, they clear from the set and the bookmark advances naturally.
- `gbrain apply-migrations --force-retry <version>` — reset a wedged migration (3 consecutive partials with no completion) by appending a `'retry'` marker. Next `apply-migrations --yes` treats the version as fresh. `complete` status never regresses to `partial` either before or after a retry marker.
- `GBRAIN_POOL_SIZE` env var — honored by both the singleton pool (`src/core/db.ts`) and the parallel-import worker pool (`src/commands/import.ts`). Default is 10; lower to 2 for Supabase transaction pooler to avoid MaxClients crashes during `gbrain upgrade` subprocess spawns. Read at call time via `resolvePoolSize()`.
- `gbrain doctor` gains two new checks: `sync_failures` (surfaces unacknowledged parse failures with exact paths + fix hints) and `brain_score` (renders the 5-component breakdown when score < 100: embed coverage / 35, link density / 25, timeline coverage / 15, orphans / 15, dead links / 10 — sum equals total).

Key commands added in v0.26.0 (OAuth 2.1 + HTTP server + admin dashboard):
- `gbrain serve --http [--port 3131] [--token-ttl 3600] [--enable-dcr] [--log-full-params]` — HTTP MCP server with OAuth 2.1, admin dashboard at `/admin`, SSE activity feed at `/admin/events`, health check at `/health`. Prints admin bootstrap token on first start. Alongside (not replacing) stdio `gbrain serve`. As of v0.26.9, `mcp_request_log.params` and the SSE feed default to a redacted summary (`{redacted, kind, declared_keys, unknown_key_count, approx_bytes}`); pass `--log-full-params` to log raw payloads on a personal laptop with a startup warning.
- **OAuth client registration** — three paths:
  1. CLI: `gbrain auth register-client <name> --grant-types <types> --scopes <scopes>` (wired into `src/commands/auth.ts` as a thin wrapper over `GBrainOAuthProvider.registerClientManual`). Default grant types: `client_credentials`. Default scopes: `read`.
  2. Admin dashboard: Register client modal → credential reveal with Copy + Download JSON.
  3. SDK: `oauthProvider.registerClientManual(name, grantTypes, scopes, redirectUris)` for programmatic wrappers.
  `--enable-dcr` on `serve --http` opens the `/register` endpoint for RFC 7591 self-service registration (off by default).
- `gbrain auth create|list|revoke|test` — legacy bearer tokens still work and grandfather to `read+write+admin` scopes on the OAuth server. `auth` is wired as a first-class `gbrain` subcommand in v0.26.0 (previously only invokable via `bun run src/commands/auth.ts`). No migration required to keep pre-v0.26 clients working.

Key commands added in v0.14.3 (fix wave):
- `gbrain doctor --index-audit` — opt-in Postgres-only check reporting zero-scan indexes from `pg_stat_user_indexes`. Informational only; never auto-drops.
- `gbrain doctor` schema_version check fails loudly when `version=0` — catches `bun install -g github:...` postinstall failures (#218) and routes users to `gbrain apply-migrations --yes`.
- `gbrain jobs submit` gains `--max-stalled`, `--backoff-type`, `--backoff-delay`, `--backoff-jitter`, `--timeout-ms`, `--idempotency-key` — exposing existing `MinionJobInput` fields as first-class CLI flags.
- `gbrain jobs smoke --sigkill-rescue` — opt-in regression smoke case simulating a killed worker; asserts the v0.14.3 schema default (`max_stalled=5`) actually rescues on first stall.

Key commands added in v0.22.13 (PR #490):
- `gbrain sync --workers N` (alias `--concurrency N`) — parallelize the import phase using per-worker Postgres engines (small pool of 2 each) with an atomic queue index. Auto-concurrency: defaults to 4 workers when the diff exceeds 100 files. Smaller diffs stay serial. Explicit `--workers` always wins (even on a 30-file diff). PGLite forces serial regardless. Validation rejects `0`, negatives, non-integers loud (replaces the prior silent fall-through to auto-concurrency).
- `gbrain import --workers N` — same `parseWorkers()` validation as sync; same try/finally worker-engine cleanup. Behavior surface unchanged.

Key commands added in v0.22.16 (claw-test friction loop):
- `gbrain claw-test [--scenario fresh-install|upgrade-from-v0.18] [--keep-tempdir]` — scripted-mode CI gate that runs the full canonical first-day flow against a fresh tempdir. Asserts every expected `--progress-json` phase fired and doctor's `status === 'ok'`. ~30s, no API keys.
- `gbrain claw-test --live --agent openclaw` — friction-discovery mode. Spawns real openclaw, hands it `BRIEF.md`, captures stdin/stdout/stderr to `<run>/transcript.jsonl`, lets the agent log friction via the friction CLI. Run on demand; ~5–10 min and ~$1–2 in tokens.
- `gbrain claw-test --list-agents` — reports which agent runners are registered + their detection state (binary path or unavailable reason).
- `gbrain friction log --severity {confused|error|blocker|nit} --phase <name> --message <text> [--hint ...] [--kind {friction|delight}] [--run-id ...]` — append a friction or delight entry to the active run JSONL.
- `gbrain friction render --run-id <id> [--json] [--transcripts] [--no-redact]` — markdown report grouped by severity + phase; `--redact` is the default for md output (strips `$HOME`/`$CWD` placeholders so reports paste safely in PRs/issues).
- `gbrain friction list [--json]` — recent run-ids with friction/delight counts; interrupted runs marked `(interrupted)`.
- `gbrain friction summary --run-id <id> [--json]` — two-column friction + delight summary.
- `GBRAIN_HOME` env override is now honored uniformly across every gbrain write site (config, audit, friction, sync-failures, import checkpoint, integrity log, integrations heartbeat, migration rollback, etc.) — `gbrainPath(...)` from `src/core/config.ts` is the canonical helper. Read-side host-fingerprint detection (`~/.claude`/`~/.openclaw` etc.) intentionally NOT confined in v1; that's a v1.1 follow-up.

## Testing

### Test command tiers (v0.26.4 — parallel fast loop)

Five tiers of test commands, each with a clear scope:

| Command | What it runs | Wallclock | When to use |
|---|---|---|---|
| `bun run test` | Parallel unit-test fast loop. 8-shard fan-out via `scripts/run-unit-parallel.sh`, then a serial pass over `*.serial.test.ts`. Excludes `*.slow.test.ts` and `test/e2e/*`. No pre-checks, no typecheck. | ~85s on a Mac dev box (3650+ tests) | Inner edit loop. Default. |
| `bun run verify` | CI's authoritative pre-test gate set: `check:privacy && check:jsonb && check:progress && check:wasm && bun run typecheck`. The 4 checks `.github/workflows/test.yml` runs on shard 1 + typecheck. Single source of truth — CI literally calls `bun run verify`. | ~12s (wasm-compile dominates) | Before pushing; before `/ship`. |
| `bun run test:full` | `verify && bun run test && bun run test:slow && [smart e2e]`. The local equivalent of "everything CI runs." Smart e2e: runs e2e only when `DATABASE_URL` is set; else loud skip notice to stderr. | ~3-5min depending on slow + e2e | Pre-merge sanity, before opening a PR. |
| `bun run test:slow` | Just the `*.slow.test.ts` set (intentional cold-path correctness checks). | seconds-to-minutes | When touching slow-path code. |
| `bun run test:serial` | Just the `*.serial.test.ts` set (cross-file-contention quarantine; runs at `--max-concurrency=1`). | ~1s per quarantined file | Debugging a specific quarantined file. |
| `bun run test:e2e` | Real Postgres E2E. Requires Docker + `DATABASE_URL`. Sequential (template-DB parallelization is a v0.27+ TODO). | ~5-10min | Pre-ship; nightly. |
| `bun run check:all` | All 7 historical pre-checks (privacy + jsonb + progress + no-legacy-getconnection + trailing-newline + wasm + exports-count). Superset of `verify`. | ~10s | Local-only sweep. The 4 not in `verify` are nice-to-haves. |

### CI vs local: intentionally divergent file sets

- **CI matrix** (`.github/workflows/test.yml`) runs `scripts/test-shard.sh` 4-way, which uses FNV-1a hash bucketing and INCLUDES `*.slow.test.ts`. As of v0.31.4.1, CI EXCLUDES `*.serial.test.ts` from the hash buckets and runs them on shard 1 via `bun run test:serial` at `--max-concurrency=1`. Before that, serial files were hashed in alongside parallel files, which broke the `mock.module` quarantine (top-level mocks in serial files leaked into the parallel files they shared a shard process with — most visibly, `eval-takes-quality-runner.serial.test.ts` stubbed `gateway.ts` and broke every `gateway.embedMultimodal` test in `voyage-multimodal.test.ts` on shard 2). CI is the ground truth for "did everything pass."
- **Local fast loop** (`scripts/run-unit-shard.sh` via the parallel wrapper) uses round-robin-by-index sharding and EXCLUDES `*.slow.test.ts` AND `*.serial.test.ts`. Local trades coverage for inner-loop speed; CI catches what local skips.

This divergence is intentional. Don't try to make them equal — the two scripts deliberately solve different problems. The regression test at `test/scripts/run-unit-shard.test.ts` pins what the local fast loop should and shouldn't include.

### Failure-first logging

When `bun run test` finds any failure, the wrapper:

1. Writes failure blocks (each prefixed with `--- shard N: <test name> ---`) to `.context/test-failures.log` (workspace-local, gitignored). On systems without a writable `.context/`, falls back to `/tmp/gbrain-test-failures.log`.
2. Prints a loud stderr banner with the absolute log path, plus the last 30 lines of the failure log inlined. Banner survives `| head` / `| tail` / agent-side log truncation.
3. Writes a one-line-per-shard summary to `.context/test-summary.txt` (`shard N/M: pass=X fail=Y skip=Z rc=W`).
4. Exits non-zero. Empty failure log + non-zero exit = infrastructure problem (wedged shard, killed child); the banner says so.

If a shard wedges (per-shard `GBRAIN_TEST_SHARD_TIMEOUT` cap, default 600s), the wrapper writes `--- shard N: WEDGED after ${SHARD_TIMEOUT}s ---` to the failure log, includes the last 50 lines of the shard log, and proceeds with other shards' results.

### File taxonomy

- `*.test.ts` → fast loop (parallel 8-shard fan-out).
- `*.slow.test.ts` → run via `bun run test:slow` only (intentional cold-path tests; would dominate the fast loop's wallclock).
- `*.serial.test.ts` → run via `bun run test:serial` after the parallel pass completes; uses `--max-concurrency=1`. Quarantine for tests that share file-wide state and race when run alongside other files in the same `bun test` process. Currently: `test/brain-registry.serial.test.ts`, `test/reconcile-links.serial.test.ts`, `test/core/cycle.serial.test.ts`, `test/embed.serial.test.ts` (the latter two added in v0.26.7 — they use `mock.module(...)` which leaks across files in the shard process). **Do not put the parallelism back on a serial file unless you've fixed the contention root cause** (it just re-introduces the flake).
- `test/e2e/*.test.ts` → real-Postgres E2E. Skipped when `DATABASE_URL` is unset.
- `tests/heavy/*.sh` → ops-shape shell scripts. Cost minutes per run; NOT in default `bun test`. Run via `bun run test:heavy` or scheduled nightly via `.github/workflows/heavy-tests.yml`. Examples: pg_upgrade matrix (boot legacy brain → walk to head), RSS budget gate (measure peak worker RSS vs committed baseline), read-latency-under-sync (p50/p95/p99 under concurrent writer load), sync lock regression (N concurrent syncs assert 1 winner + N-1 lock-busy + zero leaked `gbrain_cycle_locks` rows). See `tests/heavy/README.md` for when to add a script here vs `*.slow.test.ts`. Files prefixed with `_` (e.g. `tests/heavy/_build_legacy_fixtures.sh`) are helpers/libs invoked by sibling tests — the runner skips them.
- `test/fuzz/*.test.ts` → property-based fuzz harness. Pure-validator targets in `pure-validators.test.ts` are guarded by `scripts/check-fuzz-purity.sh` (in `bun run verify`), which `bun build --target=bun` bundles each target and greps the resulting bundle for banned transitive imports (`node:fs`, `node:child_process`, engine modules). Anything that fails the guard moves to `mixed-validators.test.ts` (still property-tested, but no purity guarantee) or `filesystem-validators.test.ts` (fs-backed, uses temp dirs). Fuzz tests run in the default `bun test` loop because they're fast (~3s for ~12 properties × 1000 runs each).

The intra-file parallelism project (turn `bun test` into `bun test --concurrent` after sweeping shared-state contention sites) is sliced across v0.26.7 (foundation), v0.26.8 (env-mutation sweep), and v0.26.9 (PGLite sweep + codemod + measurement). v0.26.4 ships file-level parallelism only.

### Test-isolation lint and helpers (v0.26.7)

The cross-file flake class is enforced statically by `scripts/check-test-isolation.sh`, wired into `bun run verify` and `bun run check:all`. Rules (non-serial unit files only; `*.serial.test.ts` and `test/e2e/*` are skipped):

| Rule | What it bans | Fix |
|---|---|---|
| **R1** | `process.env.X = ...`, bracket assignment, `delete process.env.X`, `Object.assign(process.env, ...)`, `Reflect.set(process.env, ...)` | Use `withEnv()` from `test/helpers/with-env.ts`, OR rename file to `*.serial.test.ts` |
| **R2** | `mock.module(...)` anywhere in the file | Rename file to `*.serial.test.ts` (no DI on production code for testability) |
| **R3** | `new PGLiteEngine(` outside ~50 lines after a `beforeAll(` line | Use the canonical block (below) inside `beforeAll(` |
| **R4** | Files creating `new PGLiteEngine(` without `engine.disconnect(` inside an `afterAll(` block | Add `afterAll(() => engine.disconnect())` |

Files that violated these rules at the v0.26.7 baseline are listed in `scripts/check-test-isolation.allowlist`. **The allow-list MUST shrink over time** — never add new entries. v0.26.8 (env sweep) and v0.26.9 (PGLite sweep) remove entries as files get fixed.

#### Canonical PGLite block (R3 + R4 compliant)

Every test file that needs a PGLite engine should use this exact pattern:

```ts
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
});
```

Why this exact shape: `beforeAll` creates a single engine per file (PGLite WASM cold-start + initSchema is ~20s); `beforeEach` truncates user data via `resetPgliteState` ("two orders of magnitude faster" than fresh-engine-per-test); `afterAll` disconnects so the engine doesn't leak across file boundaries within a shard process.

#### `withEnv` pattern (R1 fix)

```ts
import { withEnv } from './helpers/with-env.ts';

test('reads OPENAI_API_KEY', async () => {
  await withEnv({ OPENAI_API_KEY: 'sk-test' }, async () => {
    expect(loadConfig().openai_key).toBe('sk-test');
  });
});

// Delete a var (override is undefined):
await withEnv({ GBRAIN_HOME: undefined }, fn);

// Multiple keys:
await withEnv({ A: '1', B: '2', C: undefined }, fn);
```

`withEnv` saves the prior value of every key it touches and restores via try/finally — including when the callback throws. **It is cross-test safe but NOT intra-file concurrent-safe.** `process.env` is process-global; two `test.concurrent()` calls in the same file both touching the same key will race. Files using `withEnv` stay outside the future `test.concurrent()` codemod's eligibility filter.

#### When to quarantine instead of fix

Rename to `*.serial.test.ts` when:
- The file uses `mock.module(...)` (R2 — there's no clean fix without changing production code).
- The file is genuinely env-coupled (e.g. `gbrain-home-isolation.test.ts`, `claw-test-cli.test.ts`) — module-load env readers + ESM caching defeat dynamic-import-after-env tricks.
- The file's tests intentionally share state across `it()` boundaries.

Quarantine count cap: 10 (informational). Beyond that, push back on the design.

### Test inventory

The full per-test inventory — every unit and E2E test file and what it pins — moved to `docs/testing.md` (it's reference, not loaded into agent context). Run `ls test/ test/e2e/` for the current set; read `docs/testing.md` for what each file covers.

- Tier 2 (`skills.test.ts`) requires OpenClaw + API keys, runs nightly in CI
- If `.env.testing` doesn't exist in this directory, check sibling worktrees for one:
  `find ../  -maxdepth 2 -name .env.testing -print -quit` and copy it here if found.
- **Run E2E tests without asking permission.** When you want to verify behavior,
  there's a relevant E2E test, or you're shipping touching anything covered by an
  E2E suite — just spin up the test DB, run the tests, and tear down. Don't ask,
  don't propose it, don't defer. The lifecycle is short (~2-30s startup, sub-minute
  tests, instant teardown) and the gate value is high. Skipping with "DATABASE_URL
  unset" is silent regression, not caution.

### API keys and running ALL tests

ALWAYS source the user's shell profile before running tests:

```bash
source ~/.zshrc 2>/dev/null || true
```

This loads `OPENAI_API_KEY` and `ANTHROPIC_API_KEY`. Without these, Tier 2 tests
skip silently. Do NOT skip Tier 2 tests just because they require API keys — load
the keys and run them.

When asked to "run all E2E tests" or "run tests", that means ALL tiers:
- Tier 1: `bun run test:e2e` (mechanical, sync, upgrade — no API keys needed)
- Tier 2: `test/e2e/skills.test.ts` (requires OpenAI + Anthropic + openclaw CLI)
- Always spin up the test DB, source zshrc, run everything, tear down.

### E2E test DB lifecycle (ALWAYS follow this)

You are responsible for spinning up and tearing down the test Postgres container.
Do not leave containers running after tests. Do not skip E2E tests, do not ask
permission to run them — see the "run without asking" rule above.

1. **Check for `.env.testing`** — if missing, copy from sibling worktree.
   Read it to get the DATABASE_URL (it has the port number).
2. **Check if the port is free:**
   `docker ps --filter "publish=PORT"` — if another container is on that port,
   pick a different port (try 5435, 5436, 5437) and start on that one instead.
3. **Start the test DB:**
   ```bash
   docker run -d --name gbrain-test-pg \
     -e POSTGRES_USER=postgres -e POSTGRES_PASSWORD=postgres \
     -e POSTGRES_DB=gbrain_test \
     -p PORT:5432 pgvector/pgvector:pg16
   ```
   Wait for ready: `docker exec gbrain-test-pg pg_isready -U postgres`
4. **Bootstrap the schema** (required — fresh containers have no `oauth_clients`,
   `mcp_request_log`, `pages` etc.; tests like `serve-http-oauth.test.ts` will fail
   with `relation "oauth_clients" does not exist` if you skip this):
   ```bash
   DATABASE_URL=postgresql://postgres:postgres@localhost:PORT/gbrain_test \
     bun run src/cli.ts doctor --json > /dev/null 2>&1
   ```
   `gbrain doctor` triggers `initSchema()` on first connect, which is the canonical
   way to bring a fresh DB to head. `apply-migrations --yes` alone does NOT seed
   the base schema — it runs ALTER-style migrations on top of `initSchema`. Tests
   that bypass the engine (raw `execSync`-spawned `auth register-client`) hit the
   schema directly and need this step to have run first.
5. **Run E2E tests:**
   `DATABASE_URL=postgresql://postgres:postgres@localhost:PORT/gbrain_test bun run test:e2e`
6. **Tear down immediately after tests finish (pass or fail):**
   `docker stop gbrain-test-pg && docker rm gbrain-test-pg`

Never leave `gbrain-test-pg` running. If you find a stale one from a previous run,
stop and remove it before starting a new one.

## Search Mode (v0.32.3)

GBrain ships three named search modes that bundle the search-lite knobs from
PR #897 into a single config key. Pick one at install time; the rest of the
project resolves through `src/core/search/mode.ts`.

| Knob                          | `conservative` | `balanced` | `tokenmax`     |
|-------------------------------|----------------|------------|----------------|
| `cache.enabled`               | true           | true       | true           |
| `cache.similarity_threshold`  | 0.92           | 0.92       | 0.92           |
| `cache.ttl_seconds`           | 3600           | 3600       | 3600           |
| `intentWeighting`             | true           | true       | true           |
| `tokenBudget`                 | **4000**       | **12000**  | **off**        |
| `expansion` (LLM multi-query) | false          | false      | **true**       |
| `searchLimit` default         | 10             | 25         | 50             |

**Cost anchors (downstream agent input cost — gbrain itself is rounding error).**
The corner-to-corner spread is 25x once you pair mode with downstream model.
Chunks ~400 tokens avg. Per-query cost @ 10K queries/month (typical
single-user volume), full search payload, no cache savings:

| Mode \ Downstream | Haiku 4.5 (\$1/M) | Sonnet 4.6 (\$3/M) | Opus 4.7 (\$5/M) |
|---|---|---|---|
| conservative (~4K) | **\$40/mo** | \$120/mo | \$200/mo |
| balanced (~10K) | \$100/mo | \$300/mo | \$500/mo |
| tokenmax (~20K) | \$200/mo | \$600/mo | **\$1,000/mo** |

Scales linearly: multiply by 10 for 100K/mo (heavy power user / multi-user
fleet); divide by 10 for 1K/mo (light usage). Natural pairings span ~4x.
Mismatches (tokenmax+Haiku, conservative+Opus) waste capacity differently
— too-big payload overwhelms a cheap model; too-small payload starves an
expensive one.

tokenmax adds ~\$1.50 per 1K queries in Haiku expansion calls on top of
the matrix (\$15/mo @ 10K). Cache hits cut all numbers ~50%. **The cost
picker copy in `gbrain init` carries the same matrix verbatim** — update
both when refreshing.

**Per-query math vs real-world spend.** The matrix above is what an
isolated benchmark would measure. Real agent loops with disciplined
Anthropic prompt caching see 50-80% discount on top (cache hits skip
downstream entirely). The realistic-scale anchor in
`docs/eval/SEARCH_MODE_METHODOLOGY.md` walks the natural pairings at
single-power-user volume (~860 turns/mo): tokenmax+Opus ~\$700/mo,
balanced+Sonnet ~\$430/mo, conservative+Haiku ~\$170/mo. Setups WITHOUT
cache-aware prompt layout (frequent prefix churn) see the per-query
matrix dominate — mode + model choice matters more there.

**Resolution chain** (matches the v0.31.12 model-tier pattern at
`src/core/model-config.ts:resolveModel`):

    per-call SearchOpts → per-key config (search.cache.enabled, …) →
      MODE_BUNDLES[search.mode] → MODE_BUNDLES.balanced (fallback)

Mode resolution lives in **bare `hybridSearch`** (NOT just the cached wrapper)
per `[CDX-5+6]` in `~/.claude/plans/lets-take-a-look-validated-parrot.md` — so
`gbrain eval replay` and `gbrain eval longmemeval` test the same mode-affected
behavior as the production `query` op.

**Cache-key contamination hotfix `[CDX-4]`:** migration v56 added a
`knobs_hash` column to `query_cache`. The lookup filter is now
`WHERE source_id = $ AND knobs_hash = $ AND embedding similarity < $` so a
tokenmax write (expansion=on, limit=50) can't be served to a conservative
read.

**v0.36.3.0 knobs_hash v=2 → v=3.** The hash now folds the active
embedding column name + provider into the cache key, so a query routed
through `embedding_voyage` (1024d Voyage) can't be served a cache row
written against `embedding` (1536d OpenAI). Existing v=2 rows become
unreachable on first re-query (one-time miss spike on upgrade);
`mode.ts:KNOBS_HASH_VERSION` is the single source of truth.

**Three CLI surfaces:**

    gbrain search modes              # what is running, with per-knob attribution
    gbrain search modes --reset      # clear search.* overrides (mode bundle wins)
    gbrain search stats [--days N]   # cache hit rate, intent mix, budget drops
    gbrain search tune [--apply]     # data-driven recommendations

The install picker fires inside `gbrain init` AFTER `engine.initSchema()`
(non-TTY auto-selects). The upgrade banner fires once via `runPostUpgrade`
in `src/commands/upgrade.ts`, gated by `search.mode_upgrade_notice_shown`.

## Eval discipline (v0.32.3)

Every metric printed by any `gbrain eval *` or `gbrain search stats` command
resolves through `src/core/eval/metric-glossary.ts` so industry terms
(`P@k`, `nDCG@k`, `MRR`, `Jaccard@k`) carry a plain-English line in human
output and a `_meta.metric_glossary` block in JSON output (one block per
response per `[CDX-25]`, NOT sibling `_gloss` fields).

The full methodology — datasets, sample selection, pre-registered
expectations, threats to validity, paired-bootstrap + Bonferroni p-value
discipline `[CDX-14]` — lives in `docs/eval/SEARCH_MODE_METHODOLOGY.md`.
Auto-regenerated `docs/eval/METRIC_GLOSSARY.md` is CI-guarded against
drift (`scripts/check-eval-glossary-fresh.sh`).

Per-run records land at `<repo>/.gbrain-evals/eval-results.jsonl` per
`[CDX-23]`. The user's personal `~/.gbrain` brain is NEVER touched —
audit trail lives in the source repo's git history.

## Skills

Read the skill files in `skills/` before doing brain operations. GBrain ships 29 skills
organized by `skills/RESOLVER.md` (`AGENTS.md` is also accepted as of v0.19):

**Original 8 (conformance-migrated):** ingest (thin router), query, maintain, enrich,
briefing, migrate, setup, publish.

**Brain skills (ported from an upstream agent fork):** signal-detector, brain-ops, idea-ingest, media-ingest,
meeting-ingestion, citation-fixer, repo-architecture, skill-creator, daily-task-manager.

**Operational + identity:** daily-task-prep, cross-modal-review, cron-scheduler, reports,
testing, soul-audit, webhook-transforms, data-research, minion-orchestrator. As of
v0.20.4, `minion-orchestrator` is the single unified skill for both lanes of background
work (shell jobs via `gbrain jobs submit shell`, LLM subagents via `gbrain agent run`) ...
the prior `gbrain-jobs` skill was merged in, Preconditions are shared, and trigger
routing is narrowed to what the skill actually covers.

**Skillify loop (v0.19):** skillify (the markdown orchestration), skillpack-check
(agent-readable health report).

**Routing-table compression (v0.32.3.0):** `skills/functional-area-resolver/` —
two-layer dispatch pattern for shrinking large AGENTS.md / RESOLVER.md files
(>=12KB) without losing routing accuracy. Replaces one row per skill with one
entry per functional area, where each area declares its sub-skills in a
`(dispatcher for: ...)` clause. The static-prompt analog of hierarchical agent
routing (AnyTool [arXiv:2402.04253](https://arxiv.org/abs/2402.04253), RAG-MCP
[arXiv:2505.03275](https://arxiv.org/html/2505.03275v1), Anthropic Agent Skills
progressive disclosure). Empirically validated across Opus 4.7 / Sonnet 4.6 /
Haiku 4.5: +13 to +17pp over the verbose baseline at 48% the size (25KB → 13KB
on a real fork). The `(dispatcher for: ...)` clause is the load-bearing signal
— strip it and lenient accuracy collapses to 41.7% on Sonnet (the
`resolver-of-resolvers` ablation case). A/B eval surface lives at
`evals/functional-area-resolver/` (outside `skills/` deliberately so the
skillpack bundler doesn't ship eval infrastructure to downstream installs):
gateway-routed TypeScript harness, 20 training + 5 held-out fixtures, strict +
lenient scoring, three committed cross-model receipts in `baseline-runs/`.
Receipt header binds (model, prompt_template_hash, fixtures_hash, harness_sha,
ts) so future contributors can verify reproduction. Companion `rescore.mjs`
re-scores existing JSONL with lenient tolerance for zero API cost. Reproduce
with `cd evals/functional-area-resolver && node harness.mjs --model
{opus|sonnet|haiku}` (~$0.30–1.70 per model). Nine v0.33.x follow-up TODOs
filed for held-out corpus growth, cross-vendor verification, hierarchical
area-of-areas, embedding-based pre-router, and the run-1 vs run-2
prompt-design ablation methodology.

**Operational health (v0.19.1):** smoke-test (8 post-restart health checks with auto-fix
for Bun, CLI, DB, worker, Zod CJS, gateway, API key, brain repo; user-extensible via
`~/.gbrain/smoke-tests.d/*.sh`).

**Conventions:** `skills/conventions/` has cross-cutting rules (quality, brain-first,
model-routing, test-before-bulk, cross-modal). `skills/_brain-filing-rules.md` and
`skills/_output-rules.md` are shared references.

## Bulk-action progress reporting

All bulk commands (doctor, embed, import, export, sync, extract, migrate,
repair-jsonb, orphans, check-backlinks, lint, integrity auto, eval, files
sync, and apply-migrations) stream progress through the shared reporter
at `src/core/progress.ts`. Agents get heartbeats within 1 second of every
iteration regardless of how slow the underlying work is.

Rules:
- Progress always writes to **stderr**. Stdout stays clean for data output
  (`--json` payloads, final summaries, JSON action events from `extract`).
- Non-TTY default: plain one-line-per-event human text. JSON requires the
  explicit `--progress-json` flag.
- Global flags (`--quiet`, `--progress-json`, `--progress-interval=<ms>`)
  are parsed by `src/core/cli-options.ts` BEFORE command dispatch.
- Phase names are machine-stable `snake_case.dot.path` (e.g.
  `doctor.db_checks`, `sync.imports`). Documented in
  `docs/progress-events.md`; additive changes only.
- `scripts/check-progress-to-stdout.sh` is a CI guard that fails the build
  if any new code writes `\r` progress to stdout. Wired into `bun run test`.
- Minion handlers pass `job.updateProgress` as the `onProgress` callback
  to core functions (DB-backed primary progress channel); stderr from
  `jobs work` stays coarse for daemon liveness only.

When wiring a new bulk command: `import { createProgress } from '../core/progress.ts'`
and `import { getCliOptions, cliOptsToProgressOptions } from '../core/cli-options.ts'`.
Create a reporter with `createProgress(cliOptsToProgressOptions(getCliOptions()))`,
`start(phase, total?)` before the loop, `tick()` inside it, `finish()` after.
For single long-running queries, use `startHeartbeat(reporter, note)` with a
try/finally to guarantee cleanup. Never call `process.stdout.write('\r...')`
in bulk paths, the CI guard will fail the build.

## Capturing test output (NEVER pipe through `tail` / `head`)

**Iron rule:** when running `bun test`, `bun run test:e2e`, `bun run typecheck`,
or any other test/check command, redirect to a file FIRST, then `tail` the file
separately:

```bash
# RIGHT — full output preserved, real exit code visible
bun test > /tmp/ship_units.txt 2>&1
echo "EXIT=$?"
tail -50 /tmp/ship_units.txt
grep -E '(fail\)|✗|error:' /tmp/ship_units.txt | head -30
```

```bash
# WRONG — exit code is `tail`'s (always 0), failures truncated, ship gates fail open
bun test 2>&1 | tail -10
```

The pipe form silently breaks /ship Step T1 (test failure ownership triage) and
the test verification gate (Step 16) because:
- `$?` after a pipe is the LAST command's exit code (`tail` → 0), not bun's
- bun prints failure details before the summary line, so `tail -N` drops them
- Step T1 needs the full failure list to classify in-branch vs pre-existing

This bit us during v0.26.2 ship: `bun test 2>&1 | tail -10` reported "3911 pass / 23 fail"
but no failure details survived, forcing a 23-minute re-run to triage.

Apply the same pattern to any long-running command whose exit code matters:
`bun run typecheck`, `bun run ci:local`, migration runs, eval suites, etc.
For background tasks (`run_in_background: true`), the harness captures the exit
file separately — use it via the bg task's `<id>.exit` file, not the streamed
output.

## Build

`bun build --compile --outfile bin/gbrain src/cli.ts`

## Release, changelog & PR process → docs/RELEASE_PROCESS.md

The full release machinery — version-bump locations and the four-segment version format, the CHANGELOG voice + release-summary template, branch-scoped CHANGELOG rules, the "To take advantage of v[version]" block, version-migration authoring, the Conductor branch-name rule, pre/post-ship requirements, GitHub Actions SHA maintenance, PR-description rules, the community-PR wave process, checking out PRs from `garrytan-agents`, and schema-state tracking — lives in `docs/RELEASE_PROCESS.md`. The `/ship` and `/document-release` skills read it. Read that doc before shipping.

The two cross-cutting guardrails below stay here because they apply to **any** commit, PR, or public artifact — not just releases.

## Privacy rule: scrub real names from public docs

**Never reference real people, companies, funds, or private agent names in any
public-facing artifact.** Public artifacts include: `CHANGELOG.md`, `README.md`,
`docs/`, `skills/`, PR titles + bodies, commit messages, and comments in checked-in
code. Query examples, benchmark stories, and migration guides MUST use generic
placeholders.

Why: gbrain runs a personal knowledge brain containing notes on real people and
real companies (YC founders, portfolio companies, funds, investors, meeting
attendees). When a doc copies a query like `gbrain graph diana-hu --depth 2` or
names a specific agent fork like `Wintermute`, that real name gets indexed by
search engines, surfaced in cross-references, and distributed with every release.

**Name mapping** to use in examples:
- Agent forks → `your agent fork`, `a downstream agent`, or `agent-fork`
- Example person → `alice-example`, `charlie-example`, or `a-founder`
- Example company → `acme-example`, `widget-co`, or `a-company`
- Example fund → `fund-a`, `fund-b`, `fund-c`
- Example deal → `acme-seed`, `widget-series-a`
- Example meeting → `meetings/2026-04-03` (generic date is fine)
- Example user → `you` or `the user`, never a proper name

**Specific rule: never say `Wintermute` in any CHANGELOG, README, doc, PR, or
commit message.** When the temptation is to illustrate with the real fork name:
- Reader-facing copy → `your OpenClaw` (covers Wintermute, Hermes, AlphaClaw,
  and any other downstream OpenClaw deployment in one term the reader already
  recognizes).
- First-person / origin-story copy → `Garry's OpenClaw` (honest that this is
  the production deployment driving the feature, without exposing the private
  agent's name).

`Wintermute` may appear in private artifacts (scratch plans under
`~/.gstack/projects/…`, memory files, conversation transcripts, CEO-review
plans) — those aren't distributed. Anything checked into this repo or shipped
in a release must use the OpenClaw phrasing above. Sweeping a stale reference
is a small clean-up PR, not a debate.

**When in doubt, ask yourself:** "Would this query reveal private information
about the user's contacts, investments, or portfolio if it were read by a
stranger?" If yes, replace with generic placeholders.

**Illustrative API examples with household-brand companies** (Stripe, Brex, OpenAI,
GitHub, etc.) are fine — they're public entities, not contacts in anyone's brain.
Do not confuse illustrative API examples with queries that reveal real
relationships.

## Responsible-disclosure rule: don't broadcast attack surface in release notes

**When a release fixes a security gap or a user-impacting bug, describe the fix
functionally. Do not enumerate the attack surface, quantify the exposure window,
or highlight the most sensitive records by name in public-facing artifacts.**

Public-facing artifacts include: `CHANGELOG.md`, `README.md`, `docs/`, PR titles
and bodies, commit messages, GitHub issue titles and comments, release pages,
tweets, blog posts.

**Don't write:**
- "10 tables were publicly readable by the anon key for months, including X, Y, Z"
- "X and Y are the most sensitive ones"
- "N tables exposed. Fix: enable RLS on these specific tables: ..."

**Do write:**
- "Security hardening pass. Fresh installs secure by default. Existing brains
  brought to the same bar automatically on upgrade."
- "If `gbrain doctor` still flags anything after upgrade, the message names each
  table and gives the exact fix."

Why: anyone reading the release page before they've upgraded now has a directed
probe list for unpatched installs. The source code ships the specifics anyway
(`src/schema.sql`, `src/core/migrate.ts`, test fixtures) — reverse engineers can
get them. But the release page is a broadcast channel. Don't hand attackers a
curated list with a banner.

**The test:** if a reader with no prior context could read the release note and
walk away knowing "gbrain at version X has table Y readable by anon key until
they patch," the note is too specific. Rewrite until that's no longer possible.

**What IS fine in public artifacts:**
- The mechanism of the fix ("the check now scans every public table instead of
  a hardcoded allowlist").
- User-facing operator ergonomics (the escape-hatch SQL template, the upgrade
  commands, the breaking-change flag).
- Credit to contributors.
- Generic framing of severity ("security posture tightening pass") without
  quantification.

**What stays in private artifacts (plan files, private memories, internal docs):**
- Specific table names, record counts, exposure duration.
- Which records stand out as highest-risk.
- Detailed before/after tables in the "numbers that matter" format.

If the CEO/Eng review of a plan produces a detailed exposure table, keep it in
the plan file under `~/.claude/plans/` or `~/.gstack/projects/`. Don't copy it
into the CHANGELOG or PR body.

Applies retroactively: if you see a prior CHANGELOG entry naming attack-surface
specifics, scrub it as a small cleanup commit, the same way a stale Wintermute
reference gets swept.

## Skill routing

When the user's request matches an available skill, ALWAYS invoke it using the Skill
tool as your FIRST action. Do NOT answer directly, do NOT use other tools first.
The skill has specialized workflows that produce better results than ad-hoc answers.

**NEVER hand-roll ship operations.** Do not manually run git commit + push + gh pr
create when /ship is available. /ship handles VERSION bump, CHANGELOG, document-release,
pre-landing review, test coverage audit, and adversarial review. Manually creating a PR
skips all of these. If the user says "commit and ship", "push and ship", "bisect and
ship", or any combination that ends with shipping — invoke /ship and let it handle
everything including the commits. If the branch name contains a version (e.g.
`v0.5-live-sync`), /ship should use that version for the bump.

Key routing rules:
- Product ideas, "is this worth building", brainstorming → invoke office-hours
- Bugs, errors, "why is this broken", 500 errors → invoke investigate
- Ship, deploy, push, create PR, "commit and ship", "push and ship" → invoke ship
- QA, test the site, find bugs → invoke qa
- Code review, check my diff → invoke review
- Update docs after shipping → invoke document-release
- Weekly retro → invoke retro
- Design system, brand → invoke design-consultation
- Visual audit, design polish → invoke design-review
- Architecture review → invoke plan-eng-review
- Save progress, checkpoint, resume → invoke checkpoint
- Code quality, health check → invoke health
