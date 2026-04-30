#!/usr/bin/env node
// Stop / PreCompact hook: persist conversation history to
//   <cwd>/hook-history/<timestamp>-<agent_id>.md            (Stop)
//   <cwd>/hook-history/Precompact-<timestamp>-<agent_id>.md (PreCompact)
//
// Wire up in hooks.json (both events can share this script):
//   {
//     "Stop":       [{ "hooks": [{ "type": "command", "command": "node /abs/path/save-history.js", "include_history": true, "async": true }] }],
//     "PreCompact": [{ "hooks": [{ "type": "command", "command": "node /abs/path/save-history.js", "include_history": true, "async": true }] }]
//   }

const fs = require('fs');
const path = require('path');

const MAX_BLOCK_CHARS = 4000;

let stdin = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { stdin += chunk; });
process.stdin.on('end', () => {
  try {
    const payload = JSON.parse(stdin);
    const cwd = payload.cwd;
    const agentId = payload.agent_id || 'unknown';
    const sessionId = payload.session_id || '';
    const stopReason = payload.stop_reason;
    const eventName = payload.hook_event_name || 'Stop';
    const isPreCompact = eventName === 'PreCompact';
    // Prefer the standard conversation_history (from include_history flag).
    // Fall back to context_history which PreCompact ships natively.
    const history = Array.isArray(payload.conversation_history)
      ? payload.conversation_history
      : (Array.isArray(payload.context_history) ? payload.context_history : null);

    if (!cwd) {
      console.error('[save-history] no cwd in payload, skipping');
      process.exit(0);
    }
    if (!Array.isArray(history) || history.length === 0) {
      // include_history not enabled, or empty history — nothing to do
      process.exit(0);
    }

    const safeAgent = String(agentId).replace(/[^A-Za-z0-9_.-]/g, '_');
    const dir = path.join(cwd, 'hook-history');
    fs.mkdirSync(dir, { recursive: true });

    let filePath;
    if (isPreCompact) {
      // Snapshot every PreCompact event — never dedup, never touch the Stop index.
      filePath = path.join(dir, `Precompact-${makeStamp()}-${safeAgent}.md`);
      const md = renderMarkdown({ agentId, sessionId, stopReason, eventName, payload, history });
      fs.writeFileSync(filePath, md, 'utf8');
      process.exit(0);
    }

    // Stop / default — dedup against the previous Stop run for this agent.
    // If the previous history is a prefix of the current one (same conversation,
    // just longer), overwrite the same file. O(1) check via sidecar index.
    const indexPath = path.join(dir, `.${safeAgent}.last.json`);
    const currentLastUuid = lastUuid(history);
    const prev = readIndex(indexPath);

    if (
      prev &&
      currentLastUuid &&
      typeof prev.count === 'number' &&
      prev.count >= 1 &&
      history.length >= prev.count &&
      uuidAt(history, prev.count - 1) === prev.lastUuid &&
      prev.filePath &&
      fs.existsSync(prev.filePath)
    ) {
      filePath = prev.filePath;
    } else {
      filePath = path.join(dir, `${makeStamp()}-${safeAgent}.md`);
    }

    const md = renderMarkdown({ agentId, sessionId, stopReason, eventName, payload, history });
    fs.writeFileSync(filePath, md, 'utf8');
    writeIndex(indexPath, { filePath, count: history.length, lastUuid: currentLastUuid || null });
    process.exit(0);
  } catch (err) {
    console.error(`[save-history] failed: ${err && err.message ? err.message : err}`);
    process.exit(1);
  }
});

function makeStamp() {
  const now = new Date();
  const pad = n => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}-${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;
}

function renderMarkdown({ agentId, sessionId, stopReason, eventName, payload, history }) {
  const lines = [];
  lines.push(eventName === 'PreCompact' ? '# Pre-Compact Snapshot' : '# Conversation History');
  lines.push('');
  lines.push(`- event:   \`${eventName || 'Stop'}\``);
  lines.push(`- session: \`${sessionId}\``);
  lines.push(`- agent:   \`${agentId}\``);
  lines.push(`- cwd:     \`${payload.cwd}\``);
  lines.push(`- recorded: ${payload.timestamp || new Date().toISOString()}`);
  if (stopReason) lines.push(`- stop_reason: ${stopReason}`);
  if (typeof payload.message_count === 'number') lines.push(`- message_count: ${payload.message_count}`);
  lines.push(`- messages: ${history.length}`);
  lines.push('');
  lines.push('---');
  lines.push('');

  for (let i = 0; i < history.length; i++) {
    const m = history[i];
    const role = m && m.type ? m.type : (m && m.message && m.message.role) || 'unknown';
    const heading = role.charAt(0).toUpperCase() + role.slice(1);
    lines.push(`## [${i + 1}] ${heading}`);
    lines.push('');

    const inner = m && m.message ? m.message : m;
    const content = inner && inner.content;
    renderContent(content, lines);

    if (m && m.durationMs != null) {
      lines.push('');
      lines.push(`_duration: ${m.durationMs}ms_`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

function renderContent(content, lines) {
  if (content == null) {
    lines.push('_(no content)_');
    return;
  }
  if (typeof content === 'string') {
    lines.push(truncate(content));
    return;
  }
  if (!Array.isArray(content)) {
    lines.push('```json');
    lines.push(safeStringify(content));
    lines.push('```');
    return;
  }

  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    switch (block.type) {
      case 'text':
        lines.push(truncate(block.text || ''));
        lines.push('');
        break;
      case 'thinking':
        lines.push('<details><summary>thinking</summary>');
        lines.push('');
        lines.push(truncate(block.thinking || ''));
        lines.push('');
        lines.push('</details>');
        lines.push('');
        break;
      case 'tool_use':
        lines.push(`### tool_use: \`${block.name}\` (id: \`${block.id}\`)`);
        lines.push('');
        lines.push('```json');
        lines.push(truncate(safeStringify(block.input)));
        lines.push('```');
        lines.push('');
        break;
      case 'tool_result':
        lines.push(`### tool_result (id: \`${block.tool_use_id}\`)${block.is_error ? ' [ERROR]' : ''}`);
        lines.push('');
        renderToolResult(block.content, lines);
        lines.push('');
        break;
      case 'image':
        lines.push('_[image block omitted]_');
        lines.push('');
        break;
      default:
        lines.push(`_(unknown block type: ${block.type})_`);
        lines.push('```json');
        lines.push(truncate(safeStringify(block)));
        lines.push('```');
        lines.push('');
    }
  }
}

function renderToolResult(content, lines) {
  if (typeof content === 'string') {
    lines.push('```');
    lines.push(truncate(content));
    lines.push('```');
    return;
  }
  if (Array.isArray(content)) {
    for (const sub of content) {
      if (sub && sub.type === 'text') {
        lines.push('```');
        lines.push(truncate(sub.text || ''));
        lines.push('```');
      } else if (sub && sub.type === 'image') {
        lines.push('_[image]_');
      } else {
        lines.push('```json');
        lines.push(truncate(safeStringify(sub)));
        lines.push('```');
      }
    }
    return;
  }
  lines.push('```json');
  lines.push(truncate(safeStringify(content)));
  lines.push('```');
}

function truncate(s) {
  if (typeof s !== 'string') s = String(s);
  if (s.length <= MAX_BLOCK_CHARS) return s;
  return s.slice(0, MAX_BLOCK_CHARS) + `\n... [truncated ${s.length - MAX_BLOCK_CHARS} chars]`;
}

function safeStringify(v) {
  try { return JSON.stringify(v, null, 2); } catch { return String(v); }
}

function uuidAt(history, idx) {
  const m = history[idx];
  return m && m.uuid ? m.uuid : null;
}

function lastUuid(history) {
  return uuidAt(history, history.length - 1);
}

function readIndex(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

function writeIndex(p, data) {
  try { fs.writeFileSync(p, JSON.stringify(data), 'utf8'); } catch { /* non-fatal */ }
}
