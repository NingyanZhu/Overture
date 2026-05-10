---
category: Research/Search
tags: [research, search, api, rate-limit, scope, 搜索, 调研, 限流]
updated: 2026-05-10T00:00:00Z
---

## search-rate-limit
intent: [search, api, rate-limit, retry, overload, throttled, 搜索, 限流, 重试, 限速]
AVOID: retry the same search API >3x when rate-limited; summarize from existing results or ask user

## search-task-scope
intent: [research, todolist, subtask, parallel, decompose, fanout, 调研, 拆分, 并行, 子任务]
AVOID: splitting a single research query into >5 parallel subtasks; group related searches into one call

## search-confirm-breadth
intent: [search, scope, breadth, queries, confirm, 搜索, 范围, 确认, 查询]
DO: confirm search scope with user before issuing >3 distinct queries in sequence

## search-source-dedup
intent: [search, results, sources, dedup, duplicate, 搜索, 去重, 来源, 重复]
DO: dedup results by canonical URL or title before summarizing to keep signal density high
