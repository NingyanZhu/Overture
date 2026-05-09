---
category: General/TaskBreakdown
tags: [task, breakdown, plan, decompose, parallel]
updated: 2026-05-08T00:00:00Z
---

## task-clarify-before-plan
intent: [task, ambiguous, clarify, plan, requirements]
DO: ask one targeted clarifying question when the task spans >2 plausible interpretations before planning

## task-no-premature-abstraction
intent: [refactor, abstraction, helper, generalize, premature]
AVOID: extracting helpers or interfaces before the third concrete usage exists

## task-bounded-todolist
intent: [todo, todolist, plan, breakdown, subtask]
AVOID: producing a todolist with >7 top-level items; group related steps or split into phases

## task-progress-update
intent: [task, progress, update, status, multi-step]
DO: surface a one-sentence progress update at each phase boundary in multi-step tasks

## task-test-before-claim-done
intent: [task, complete, done, verify, test, validate]
DO: run tests or exercise the change before marking a task complete; explicitly state if you could not test
