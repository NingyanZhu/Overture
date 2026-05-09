# cadence

Self-evolving **gene** layer for semaclaw. Distils single-line atomic constraints from past conversations and injects the most relevant ones into each new prompt — small, structured, low-token "do not / always do" rules that steer the agent's next turn.

Two hooks make up the loop:

| Event | Hook | Mode | Purpose |
|---|---|---|---|
| `UserPromptSubmit` | `gene-inject.js` | blocking command, ≤5 s | Score wiki genes against the user prompt and emit a top-N `<agent-genes>` block via `additionalContext` |
| `Stop` | `gene-evolve.js` | async, `include_history=true` | When 2-of-3 of {long turn-count, long LLM time, error/dissatisfaction keywords} hit, spawn `semaclaw agent-task` to distil up to 3 new genes and append them to the wiki |

The reflection step runs out-of-process via the generic `semaclaw agent-task` CLI; the hook script handles slicing, trigger judgment, history folding, JSON post-processing and Jaccard dedup, so the LLM only has to produce constrained JSON.

## Storage layout

```
~/semaclaw/wiki/Agent Genes/
  Research/Search.md          ← one .md per <Category>/<Subcategory>
  Coding/Debugging.md
  Coding/Implementation.md
  Design/UI.md
  Design/Architecture.md
  General/TaskBreakdown.md
  ...
~/.semaclaw/gene-weights.json          ← runtime weight sidecar (hits, base, last_hit)
~/.semaclaw/locks/gene-evolve.lock     ← single-runner lock
~/.semaclaw/logs/gene-evolve/<date>.jsonl  ← per-run audit trail
```

Each `.md` file holds multiple genes separated by `## <name>`:

```markdown
---
category: Research/Search
tags: [...]
updated: ...
---

## search-rate-limit
intent: [search, api, rate-limit, retry, overload]
AVOID: retry the same search API >3x when rate-limited; summarize from existing results or ask user
```

`gene_body` is **one line**, ≤ 25 words, starting with `AVOID:` or `DO:`. `intent` is the keyword set used at injection time to score relevance against the incoming prompt.

## Install / first-run

1. Drop the plugin into your semaclaw marketplace install path (or load from this repo).
2. **Seeds are copied automatically.** The first time either hook runs, if `~/semaclaw/wiki/Agent Genes/` does not exist, the entire `seeds/Agent Genes/` tree is recursively copied into the wiki. Subsequent runs detect the existing directory and never touch user content again.
3. To re-seed (e.g. after manually deleting the dir to start fresh), simply remove `~/semaclaw/wiki/Agent Genes/` and run any prompt — the next hook invocation re-seeds.
4. To prune unwanted starter genes, edit the wiki files directly. The plugin won't put them back.
5. Confirm `semaclaw agent-task --help` works (Phase 0 prerequisite). The hook reads `process.env.SEMACLAW_BIN` (auto-set by semaclaw's `resolveHookEnv`) to spawn the reflection agent.

## Configuration

`gene-categories.json` controls thresholds and budgets:

```jsonc
{
  "trigger": { "min_turns": 15, "min_assistant_duration_ms": 180000, "c2_distinct_keywords": 3 },
  "inject":  { "max_genes": 8, "min_score": 0.05, "skip_if_prompt_words_lt": 10 },
  "evolve":  { "max_genes_per_call": 3, "min_confidence": 0.6, "jaccard_dedup_threshold": 0.7,
               "history_fold_max_chars": 4000, "cli_timeout_ms": 180000,
               "tools_whitelist": "Read,Glob,Grep,Skill" }
}
```

`keywords.json` holds the four keyword categories (user-dissatisfaction / external-failure / self-correction / inefficient-pattern) used by trigger judgment.

Override the wiki path with the `WIKI_DIR` environment variable; defaults to `~/semaclaw/wiki` (matches `semaclaw wiki` CLI).

## Recursion / concurrency safety

- Both hooks check `SEMACLAW_INTERNAL_AGENT === '1'` at the top and exit immediately. The reflection agent's child SemaCore inherits this env var, so its own `Stop` will not retrigger this hook.
- `gene-evolve.js` acquires `~/.semaclaw/locks/gene-evolve.lock` via `O_EXCL`. Concurrent runs exit 0 silently. Stale locks (>1h) are reclaimed automatically.
- Every error path → exit 0 with stderr log; the hook never blocks the user-visible flow.

## Weight decay (Phase 3)

Each gene tracks `{ base, hits, last_hit }` in `~/.semaclaw/gene-weights.json`. At inject time:

```
effective_weight = base * 0.5 ^ ((now - last_hit) / 30 days)        # clamped to [0.3, 1.5]
final_score = jaccard_score(prompt_keywords, gene.intent) * effective_weight
```

- Genes never selected stay at `base = 1.0` and decay only with time
- Genes selected by `gene-inject` get `base += 0.1` (cap 1.5) and `last_hit = now`
- Freshly distilled genes from `gene-evolve` start at `base = 1.0` with `last_hit = now` (compete fairly with veterans)
- Half-life is 30 days; floor is 0.3 (so a stale gene can still win if its raw score is high enough)

This makes the wiki self-pruning *behaviourally*: dead genes drop in priority, hot genes compound. No file deletion — clean-up is still a manual periodic task (Phase 4 may surface a "stale genes" report).

## Tests

```
node --test test/hooks.test.js
```

33 tests cover weight math, tokenize/parse/score, slice extraction, trigger judgment (A/B/C 2-of-3), history folding, Jaccard dedup, and domain/body sanitization. No fs/spawn/stdin in tests — pure helper coverage.

## Audit

`~/.semaclaw/logs/gene-evolve/<YYYY-MM-DD>.jsonl` records each invocation:

```json
{"ts":"...","stage":"done","trigger":{"fire":true,"turns":18,"durationMs":221340,...},
 "proposed":3,"accepted":2,"skipped":[{"reason":"jaccard-dup",...}],
 "accepted_genes":[{"domain":"Research/Search","body":"AVOID: ..."}]}
```

Stages: `no-slice` / `not-triggered` / `cli-failed` / `cli-bad-json` / `done` / `error`. Useful when tuning thresholds or auditing distillation quality.
