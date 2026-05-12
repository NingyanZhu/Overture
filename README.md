# Overture
<img width="1701" height="809" alt="overture" src="https://github.com/user-attachments/assets/3bdda1b9-78d8-4c17-8e30-0ac651785971" />

A plugin collection for [SemaClaw](https://github.com/midea-ai/SemaClaw), providing ready-to-use subagent personas, agent skills, and lifecycle hooks.

## Packages

| Package | Description |
|---------|-------------|
| [timbre](./timbre) | Subagent persona collection — historical figures, literary characters, and MBTI types |
| [motif](./motif) | Personal skill toolkit — reusable agent skills for common workflows *(under development)* |
| [notation](./notation) | Conversation history hooks — persist chat transcripts on Stop and PreCompact events |
| [cadence](./cadence) | Self-evolving **gene** layer — `UserPromptSubmit` injects top-N atomic constraints (do/don't rules) from a wiki; `Stop` distils up to 3 new genes via `semaclaw agent-task` when long/error-prone turns hit. Low-token, structured behaviour steering that accumulates automatically across sessions |
| [repertoire](./repertoire) | Self-evolving **skill** layer — `skill-reflector` captures a just-finished workflow as a SKILL.md (or multi-file with `scripts/` / `references/` / `assets/`) only after explicit user confirmation. Triggers reactively on phrases like "save it as a skill" or proactively when the agent judges reuse value and asks. Bundled validator lints against Anthropic Agent Skills conventions |

## Getting Started

Install a package by pointing semaclaw to the plugin directory, then reference the personas or skills in your workflow configuration.

See each package's README for the full list of available content.
