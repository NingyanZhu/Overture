---
category: Coding/Debugging
tags: [debug, error, code, 调试, 报错, 程序]
updated: 2026-05-10T00:00:00Z
---

## debug-root-cause-not-symptom
intent: [debug, error, root-cause, fix, symptom, 调试, 排查, 根因, 报错, 症状]
DO: identify the root cause before patching; do not silence errors with try/catch or ignored exit codes

## debug-no-bypass-safety
intent: [bypass, no-verify, skip, hook, safety, 绕过, 跳过, 强行, 安全]
AVOID: bypassing safety checks (--no-verify, --force, ignoring failing tests) to make an obstacle go away

## debug-no-broad-refactor
intent: [bugfix, refactor, scope, cleanup, 修复, 重构, 范围, 顺手]
AVOID: bundling unrelated refactors into a bugfix; one fix per commit, leave drive-by changes for separate PRs

## debug-check-recent-changes
intent: [regression, recent, blame, git, log, 回归, 最近, 改动, 提交]
DO: check `git log` and recent commits when a previously-working feature breaks; suspect new code first
