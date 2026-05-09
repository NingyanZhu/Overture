---
category: Design/UI
tags: [ui, frontend, browser, ux]
updated: 2026-05-09T00:00:00Z
---

## ui-test-in-browser
intent: [ui, frontend, browser, dev-server, test]
DO: start the dev server and exercise UI changes in a browser before reporting done; if you cannot test in browser, say so explicitly

## ui-check-regressions
intent: [ui, regression, golden-path, edge-case]
DO: cover the golden path AND likely edge cases for the changed feature; also spot-check adjacent features for regressions

## ui-respect-existing-styles
intent: [styles, css, design-system, conventions]
AVOID: introducing new style tokens or layout primitives when the design system already has equivalents; reuse first, extend only if needed

## ui-no-emoji-unless-asked
intent: [emoji, copy, text, content]
AVOID: adding emojis to UI copy or content unless the user explicitly asks for them
