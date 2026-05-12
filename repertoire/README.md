# repertoire

Self-evolving **skill** layer for semaclaw. Unlike cadence's gene layer (which accumulates atomic constraints automatically), repertoire keeps the user in the loop: every reusable workflow is captured only after **explicit user confirmation**.

One piece:

| Component | Type | Purpose |
|---|---|---|
| `skills/skill-reflector/` | Skill | Capture a just-finished workflow as a skill (single SKILL.md, or multi-file with `scripts/` / `references/` / `assets/` when justified). Only runs after explicit user confirmation. |

The skill's `description` carries both triggering paths and their mutex:

- **Reactive** — user explicitly requests capture this turn ("save it as a skill", "存为 skill", "optimize xxx skill") → skill loads, executes
- **Proactive** — user has NOT requested → agent first JUDGES reuse value (non-obvious knowledge, persistent gotchas, project-specific rules); only if judgment passes, agent ASKS the user → wait for "yes"

No `UserPromptSubmit` hook, no per-turn token tax — the index-level description is the only entry point.

## Decision split

- **Trigger**: reactive (user-initiated phrases) OR proactive (agent judgment + ask)
- **User confirmation**: required on the proactive path; the reactive phrases ARE the confirmation
- **Skill execution** (only after confirmation): the workflow runs preflight (tax test, UPDATE/CREATE, shape match) → distil → render → validate → persist

No pending-skills file, no cross-session state, no auto-save.

## Default save path

`<user-home>/.semaclaw/managed/skills/<name>/SKILL.md` — auto-discovered by all semaclaw agents on next launch (matches `config.paths.managedSkillsDir`; resolve `<user-home>` to `$HOME` on Unix-like shells, `%USERPROFILE%` on Windows native). Workspace-local `<cwd>/skills/<name>/SKILL.md` is also valid; the skill prompts the user to choose.

## Shape: single-file or multi-file

skill-reflector drives both. Default shape is a single SKILL.md with 3–7 imperative steps. When the work needs deterministic scripts, conditional reference docs, internal hierarchy, or evals, the same skill expands to the hub-and-spoke layout (`scripts/`, `references/`, `assets/`). For multi-file patterns and eval-first design, the system's `skill-creator` skill is available as a **pattern reference** — not a routing target. skill-reflector still drives the capture.

## Validation

`skills/skill-reflector/scripts/validate-skill.js` lints any draft SKILL.md against Anthropic Agent Skills conventions: frontmatter format, required fields, kebab-case name, reserved-prefix guard, description length and routing-trigger shape, no XML, body line/word budget. Errors block writes; warnings surface to the user. The skill's own Step 3.5 calls it.

## Install

Drop the plugin into your semaclaw marketplace install path. skill-reflector is auto-discovered on next agent run (the runtime walks `<plugin>/skills/`); no restart needed.

## Why no hook, no background agent?

- **No hook**: putting the proactive nudge in `description` costs ~100 index tokens once, vs ~250 tokens injected per user prompt. Anthropic's own skill-creator does the same — descriptions can be "pushy" about when to offer the skill.
- **No background agent**: cadence runs distillation in a separate `semaclaw agent-task` process because it works on long, finished traces and the user shouldn't see the reflection text. Skill capture is the opposite — the user is the gatekeeper, and the reflection itself is part of the visible turn. Running it in-process keeps the loop tight: user says yes → main agent reads back its own conversation → validates → writes SKILL.md → tells the user where it landed.
