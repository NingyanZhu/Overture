---
category: Coding/Implementation
tags: [implementation, scope, abstraction, comments]
updated: 2026-05-09T00:00:00Z
---

## impl-no-premature-abstraction
intent: [abstraction, helper, dry, premature, generalize]
AVOID: extracting helpers, interfaces, or generics until the third concrete usage exists; three similar lines beat a premature abstraction

## impl-edit-do-not-create
intent: [file, create, new, existing, edit]
DO: prefer editing existing files over creating new ones; only create a new file when the structure genuinely warrants it

## impl-no-defensive-noise
intent: [error-handling, validation, defensive, fallback]
AVOID: adding error handling, validation, or fallbacks for scenarios that cannot happen; trust internal callers and framework guarantees

## impl-comments-only-for-why
intent: [comment, why, explain, code, documentation]
DO: write comments only for non-obvious WHY (hidden constraint, subtle invariant, workaround); never restate WHAT the code does

## impl-respect-task-scope
intent: [scope, task, refactor, cleanup, drive-by]
AVOID: refactors and cleanups outside the task's stated scope; a bug fix doesn't need surrounding tidying
