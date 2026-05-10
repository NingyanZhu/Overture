---
category: Coding/Implementation
tags: [implementation, scope, abstraction, comments, 实现, 抽象, 注释, 范围]
updated: 2026-05-10T00:00:00Z
---

## impl-no-premature-abstraction
intent: [abstraction, helper, dry, premature, generalize, 抽象, 复用, 提前, 封装]
AVOID: extracting helpers, interfaces, or generics until the third concrete usage exists; three similar lines beat a premature abstraction

## impl-edit-do-not-create
intent: [file, create, new, existing, edit, 文件, 新建, 编辑, 修改]
DO: prefer editing existing files over creating new ones; only create a new file when the structure genuinely warrants it

## impl-no-defensive-noise
intent: [error-handling, validation, defensive, fallback, 错误, 校验, 防御, 兜底]
AVOID: adding error handling, validation, or fallbacks for scenarios that cannot happen; trust internal callers and framework guarantees

## impl-comments-only-for-why
intent: [comment, why, explain, code, documentation, 注释, 解释, 说明, 文档]
DO: write comments only for non-obvious WHY (hidden constraint, subtle invariant, workaround); never restate WHAT the code does

## impl-respect-task-scope
intent: [scope, task, refactor, cleanup, drive-by, 范围, 任务, 重构, 顺手]
AVOID: refactors and cleanups outside the task's stated scope; a bug fix doesn't need surrounding tidying
