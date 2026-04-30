# notation

Conversation history hooks for semaclaw — persists agent transcripts to disk on `Stop` and `PreCompact` events.

## What it does

Each time an agent (main or virtual) finishes a turn, the hook captures the full message history and writes it as Markdown into the agent's working directory:

```
<agent-cwd>/hook-history/
├── 2026-04-30-15-23-15-main.md             # latest Stop snapshot for "main" agent
├── 2026-04-30-15-25-02-virtual-reflector.md   # latest Stop for a virtual subagent
├── Precompact-2026-04-30-15-22-58-main.md  # snapshot taken right before compaction
└── .main.last.json                          # sidecar dedup index
```

Behavior:

- **Stop event** — overwrites the previous file when the conversation just got longer (same prefix). Avoids one file per turn while still capturing the latest state.
- **PreCompact event** — always creates a new `Precompact-...md` file, so the pre-compression history is preserved even after the conversation gets summarized.
- **Per-agent files** — main agent and each virtual subagent write into their own working directories with their own `agent_id` in the filename.

## Files

- `hooks/hooks.json` — hook config registering the script for `Stop` and `PreCompact`
- `hooks/save-history.js` — Node.js script that renders the payload to Markdown

## Requirements

- Node.js available on `$PATH`
- semaclaw with the `include_history` hook field (added in the same release that ships the `${SEMACLAW_PLUGIN_ROOT}` resolution for marketplace hooks)

## Configuration

The hooks are registered automatically when this plugin is enabled in your marketplace source. No additional setup needed.

To customize per-block truncation, edit `MAX_BLOCK_CHARS` at the top of `save-history.js` (default: 4000 chars).
