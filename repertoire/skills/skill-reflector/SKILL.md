---
name: skill-reflector
description: Load when the user explicitly requests capture in the current turn — phrases like "save it as a skill", "存为 skill", "optimize xxx skill". Otherwise (user has NOT requested it), at task end agents SHOULD first JUDGE whether the workflow has real reuse value (non-obvious knowledge, persistent gotchas, project-specific rules) — only if that judgment passes, proactively ASK the user whether to invoke this skill to capture or update. MUST NOT load or run without an explicit "yes" from the user.
metadata:
  version: 1.2.0
---

**Hard precondition**: only run after explicit user confirmation in the *current* turn. Proposing to use this skill is allowed (and encouraged at the end of reusable workflows); acting without a user "yes" is not. If you arrived here without that confirmation, stop.

---

## Workflow

### Step 0a — Tax test

Every skill costs ~100 index tokens for every user, every session, forever. Decline if ≥ 2 are "no":

- Would a current model fail this task without the skill?
- Is the knowledge persistent and non-obvious (taste, gotchas, project-specific rules — not well-known CLI sequences)?
- Will it trigger more than a handful of times?

A bad skill degrades every other skill via off-target triggering. Say so plainly; do not soften.

### Step 0b — UPDATE or CREATE

**Default UPDATE** if a related skill was invoked this session and your work refined it (sharper steps, missed case, new precondition). Otherwise CREATE.

On UPDATE: skip step 0c and step 1. Use the existing SKILL.md as merge base, go to step 2, show diff bullets in step 5.

### Step 0c — Match the shape to the work (CREATE only)

Default shape is a **single SKILL.md with 3–7 imperative steps**. If any signal applies, expand to a multi-file skill with the standard hub-and-spoke layout (`scripts/`, `references/`, `assets/`):

- Wants `scripts/` (deterministic logic the agent should run, not re-derive)
- Wants `references/` (conditional docs read on demand — API tables, error codes, large schemas)
- 8+ steps, multiple branches, or > 20 sub-topics (needs internal hierarchy)
- Benefits from evals / test cases

For multi-file patterns, eval-first design, or validator scripts, you may consult the system's `skill-creator` skill as a reference (if installed in the environment) if necessary. 

### Step 1 — Confirm scope (one compact question)

Surface to the user with Ask User tool, in one short turn:

- **Proposed name** — kebab-case, ≤ 4 words, lowercase, no spaces. Must not contain "claude" or "anthropic" (reserved).
- **One-line description preview** (you'll finalise it in step 3, but show the shape now so the user can redirect early). Use the "Load when…" form, not "Does X".
- **Save path** — default `<user-home>/.semaclaw/managed/skills/<name>/SKILL.md` (auto-discovered by all semaclaw agents on next launch; resolve `<user-home>` to `$HOME` on Unix-like shells, `%USERPROFILE%` on Windows native). Mention workspace-local `<cwd>/skills/<name>/SKILL.md` as alternative only if the user asks.

Wait for confirmation.

### Step 2 — Distil with the right filter

This is where reflector captures usually fail. Apply:

1. **Skip what the model already knows.** Write *intent and constraints*, not command sequences. Bad: `git log; git checkout main; git checkout -b clean; git cherry-pick <sha>`. Good: `Cherry-pick onto a clean branch; resolve conflicts preserving intent; if it can't land cleanly, explain why.`

2. **Gotchas > steps.** Mine the conversation for user corrections, failed first attempts, non-obvious preconditions — those become Critical Rules. No gotcha = no skill (return to step 0a).

3. **3–7 imperative steps.** Every bullet must answer "would the agent fail without this?" — cut otherwise. (Pascal: short skills are harder to write than long ones.)

4. **Don't railroad.** Where multiple approaches work, give the constraint, not the recipe.

### Step 3 — Render the SKILL.md

Match the format below. This is the Anthropic standard frontmatter + body.

```markdown
---
name: <kebab-case-name>
description: Load when <user-intent verbatim from real usage>. <Trigger phrases real users would type>. (Optional) Do NOT trigger when <adjacent off-target pattern, if a confusable neighbour exists>. < 1024 chars total. No XML tags.
metadata:
  version: 1.0.0
---

# <Title Case Name>

<One short paragraph: the problem this skill solves and the shape of its output. No history, no rationale.>

## Workflow

1. **<Verb-phrase step>** — what to do, in one or two sentences. Include exact commands only when the command itself is non-obvious.
2. **<Verb-phrase step>** — …
3. …

## Critical Rules

- <Gotcha or precondition that would cause failure if violated>
- <Negative example: what NOT to do, with the reason>
- …

## Example (optional, only if it clarifies a step)

<One short worked example. No raw tool output, no session IDs, no transcript-style prose.>
```

**No `## When to Trigger` section in the body for flat single-file skills.** Triggering is fully determined by `description` at the index layer — by the time the body loads, routing is over. A body-level routing section is only meaningful for composite skills that select between sub-workflows or reference files (e.g. `cloud-deploy/SKILL.md` choosing among `aws.md / gcp.md / azure.md`). For that pattern, see step 0c and the system `skill-creator` skill.

Rules for filling the template:

- **The `description` line is the highest-leverage thing in the whole skill.** It's the only part always in the model's context — by the time the body loads, routing is already done. Phrase it as a routing trigger ("Load when…"), not a feature ad ("This skill helps with…"). Embed verbatim user phrases that should trip it — real frustrated-engineer language pulled from the conversation ("babysit the PR", "查一下", "积淀一下"), not the formal name of the workflow.
- **Keep the body under ~500 lines.** If you're approaching that, move overflow into `references/` (progressive disclosure) — see step 0c for the multi-file layout.
- **No conversation history, no session-specific IDs, no raw tool transcripts** — the skill is meant to outlive this session.
- **Match the style of any existing skill in the target directory.** Read one or two neighbouring SKILL.md files first if unsure.

### Step 3.5 — Validate (don't skip)

Write the draft to a tmp file and run the bundled validator. Code is deterministic; language judgment isn't.

```bash
# from skill-reflector's directory (or wherever this skill is installed)
node scripts/validate-skill.js /tmp/skill-draft.md
```

The validator checks: frontmatter format, required fields (`name`, `description`), kebab-case name, reserved-prefix guard ("claude"/"anthropic"), description char range (40–1024), no XML angle brackets, "Load when…" routing-trigger framing, quoted trigger phrases, body line/word budget (target < 500 lines / 5000 words, ≥ 50 words).

- **Errors → fix and re-run.** Do not write to disk until the validator exits 0.
- **Warnings → judgement call.** Show them to the user verbatim and ask whether to address or accept. Don't silently ignore.

A wrong description quietly degrades every other installed skill via off-target loading. Skipping this step is the single highest-leverage mistake you can make.

### Step 4 — Persist

```bash
mkdir -p "<parent-of-target>"
cat <<'SKILL_EOF' > "<target SKILL.md path>"
<rendered markdown>
SKILL_EOF
```

If the file already exists (always true on the UPDATE path, sometimes on CREATE if names collide):

- Read it first
- **Merge, do not replace.** Preserve the existing frontmatter, headings, trigger phrases. Touch only the sections the new conversation actually improves: tighten a step, add a missing precondition, append a newly-discovered failure mode, add a trigger phrase
- Bump `metadata.version` by a patch (1.0.0 → 1.0.1) on substantive edits; leave it alone for cosmetic ones. Anthropic's spec puts `version` under `metadata:` rather than at the top level — the IDE will flag top-level `version` as non-standard
- **Always show the user a one-bullet-per-change diff summary** before writing ("tightened step 3 / added rate-limit precondition / added trigger 'X'") and wait for approval. If they want something restored, restore it

### Step 5 — Confirm

One short sentence: where the file landed, what changed (UPDATE) or that it's new (CREATE), and a reminder that semaclaw auto-picks it up on next agent run — no restart needed for skills under `managed/skills/` or workspace `skills/`.

---

## Critical Rules

- **NEVER write** a SKILL.md without explicit user confirmation in the current turn. The description encourages you to ask, not to act
- **Apply the tax test (step 0a).** If the workflow is something a competent model handles unassisted, decline rather than produce noise
- **Match the shape to the work.** Default is single-file SKILL.md; expand to `scripts/` / `references/` / `assets/` when justified. The system `skill-creator` is a pattern reference, not a router target — skill-reflector drives
- **Default to UPDATE** when a related skill exists. A small refinement compounds; a near-duplicate is noise
- **Description is the whole game.** Spend disproportionate effort on it. Run the lint
- **Gotchas > steps.** If you cannot name a gotcha, the skill probably should not exist
- **No transcripts, no session IDs, no XML in frontmatter.** The skill outlives this session

