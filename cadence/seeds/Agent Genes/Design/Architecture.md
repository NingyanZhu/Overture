---
category: Design/Architecture
tags: [architecture, refactor, abstraction, boundaries]
updated: 2026-05-09T00:00:00Z
---

## arch-trace-data-flow-first
intent: [architecture, data-flow, trace, integration]
DO: trace the data flow end-to-end before proposing structural changes; understand who calls what before drawing new boundaries

## arch-validate-at-boundary
intent: [validation, boundary, input, trust]
DO: validate inputs at system boundaries (user input, external APIs); trust internal code and framework guarantees within the boundary

## arch-no-speculative-flexibility
intent: [flexibility, future, generalize, premature]
AVOID: adding configuration options, plugins, or extension points for hypothetical future requirements; design for current needs

## arch-prefer-singletons-when-natural
intent: [singleton, state, module, registry]
DO: prefer process-level singletons (module-level registries) over passing state through every layer when the state is truly process-wide

## arch-feature-flag-tradeoff
intent: [feature-flag, backwards, compat, tradeoff]
AVOID: feature flags or backwards-compatibility shims when you can simply change the code; revisit only when there is a real rollout constraint
