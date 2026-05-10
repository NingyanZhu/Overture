---
category: Design/UI
tags: [ui, frontend, browser, ux, 前端, 浏览器, 界面, 样式]
updated: 2026-05-10T00:00:00Z
---

## ui-test-in-browser
intent: [ui, frontend, browser, dev-server, test, 前端, 浏览器, 测试, 验证]
DO: start the dev server and exercise UI changes in a browser before reporting done; if you cannot test in browser, say so explicitly

## ui-check-regressions
intent: [ui, regression, golden-path, edge-case, 回归, 主流程, 边界, 异常]
DO: cover the golden path AND likely edge cases for the changed feature; also spot-check adjacent features for regressions

## ui-respect-existing-styles
intent: [styles, css, design-system, conventions, 样式, 设计, 规范, 复用]
AVOID: introducing new style tokens or layout primitives when the design system already has equivalents; reuse first, extend only if needed

