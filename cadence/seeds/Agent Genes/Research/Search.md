---
category: Research/Search
tags: [research, search, api, rate-limit, scope]
updated: 2026-05-08T00:00:00Z
---

## search-rate-limit
intent: [search, api, rate-limit, retry, overload, throttled]
AVOID: retry the same search API >3x when rate-limited; summarize from existing results or ask user

## search-task-scope
intent: [research, todolist, subtask, parallel, decompose, fanout]
AVOID: splitting a single research query into >5 parallel subtasks; group related searches into one call

## search-confirm-breadth
intent: [search, scope, breadth, queries, confirm]
DO: confirm search scope with user before issuing >3 distinct queries in sequence

## search-source-dedup
intent: [search, results, sources, dedup, duplicate]
DO: dedup results by canonical URL or title before summarizing to keep signal density high
