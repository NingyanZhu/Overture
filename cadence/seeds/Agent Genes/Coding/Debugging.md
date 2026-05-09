---
category: Coding/Debugging
tags: [debug, error, root-cause, regression]
updated: 2026-05-09T00:00:00Z
---

## debug-root-cause-not-symptom
intent: [debug, error, root-cause, fix, symptom]
DO: identify the root cause before patching; do not silence errors with try/catch or ignored exit codes

## debug-no-bypass-safety
intent: [bypass, no-verify, skip, hook, safety]
AVOID: bypassing safety checks (--no-verify, --force, ignoring failing tests) to make an obstacle go away

## debug-reproduce-first
intent: [bug, reproduce, repro, minimal, isolate]
DO: build a minimal reproduction before attempting a fix; if you can't reproduce, say so explicitly

## debug-no-broad-refactor
intent: [bugfix, refactor, scope, cleanup]
AVOID: bundling unrelated refactors into a bugfix; one fix per commit, leave drive-by changes for separate PRs

## debug-check-recent-changes
intent: [regression, recent, blame, git, log]
DO: check `git log` and recent commits when a previously-working feature breaks; suspect new code first
