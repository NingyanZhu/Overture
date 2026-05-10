---
category: Design/Architecture
tags: [architecture, refactor, 架构, 重构]
updated: 2026-05-10T00:00:00Z
---

## arch-trace-data-flow-first
intent: [architecture, data-flow, trace, integration, 架构, 数据, 链路, 追踪]
DO: trace the data flow end-to-end before proposing structural changes; understand who calls what before drawing new boundaries

## arch-validate-at-boundary
intent: [validation, boundary, input, trust, 校验, 边界, 输入, 信任]
DO: validate inputs at system boundaries (user input, external APIs); trust internal code and framework guarantees within the boundary

## arch-no-speculative-flexibility
intent: [flexibility, future, generalize, premature, 灵活, 未来, 扩展, 过度]
AVOID: adding configuration options, plugins, or extension points for hypothetical future requirements; design for current needs

## arch-prefer-singletons-when-natural
intent: [singleton, state, module, registry, 单例, 状态, 模块, 全局]
DO: prefer process-level singletons (module-level registries) over passing state through every layer when the state is truly process-wide

## arch-feature-flag-tradeoff
intent: [feature-flag, backwards, compat, tradeoff, 开关, 兼容, 灰度, 取舍]
AVOID: feature flags or backwards-compatibility shims when you can simply change the code; revisit only when there is a real rollout constraint
