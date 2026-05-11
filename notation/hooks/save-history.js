#!/usr/bin/env node
// Stop / PreCompact hook: persist conversation history to
//   <cwd>/hook-history/<timestamp>-<persona>.md            (Stop)
//   <cwd>/hook-history/Precompact-<timestamp>-<persona>.md (PreCompact)
// where <persona> = basename(payload.cwd), i.e. the binding folder name
// (~/semaclaw/agents/<folder>/). sema-core writes agent_id='main' regardless
// of persona, so cwd's tail is the only reliable per-persona identifier.
//
// Additionally writes a sibling .json containing the latest *raw* LLM request
// body (and the response that followed) for this session, sourced from
// sema-core's <SEMA_ROOT>/llm_logs/<YYYY-MM-DD>[_<sessionId>].log files.
// Strategy: pick the request entry with the longest `messages` array — sema
// resends the whole conversation each turn, so the longest request is the
// freshest & most complete snapshot, and quick-model calls (short messages)
// are naturally excluded. This also collapses the "every line repeats the
// previous prefix" property of the raw log into a single deduped record.

const fs = require('fs');
const path = require('path');

const MAX_BLOCK_CHARS = 4000;
// Walk up __filename until we find the .semaclaw dir (works for both direct install
// and marketplace install: ~/.semaclaw/marketplace/<uuid>/hooks/save-history.js).
// Its parent is the user home; .sema/llm_logs lives there as a sibling of .semaclaw.
function _findSemaclaw(p) {
  let cur = path.dirname(p);
  while (true) {
    if (path.basename(cur) === '.semaclaw') return cur;
    const parent = path.dirname(cur);
    if (parent === cur) return null;
    cur = parent;
  }
}
const _semaclaw = _findSemaclaw(__filename);
const _semaDataDefault = _semaclaw
  ? path.join(path.dirname(_semaclaw), '.sema', 'llm_logs')
  : path.join(require('os').homedir(), '.sema', 'llm_logs');
const SEMA_LLM_LOGS_DIR = process.env.SEMA_LLM_LOGS
  || (process.env.SEMA_DATA_DIR && path.join(process.env.SEMA_DATA_DIR, 'llm_logs'))
  || _semaDataDefault;

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
    const history = Array.isArray(payload.conversation_history)
      ? payload.conversation_history
      : (Array.isArray(payload.context_history) ? payload.context_history : null);

    if (!cwd) {
      console.error('[save-history] no cwd in payload, skipping');
      process.exit(0);
    }
    if (!Array.isArray(history) || history.length === 0) {
      process.exit(0);
    }

    // 文件名后缀用 cwd 末尾段（= 人设目录名，例如 ~/semaclaw/agents/{folder}/ 的 folder）。
    // sema-core 写死 agent_id='main'，所有人设都会撞成 '-main.md'，没法区分；
    // basename(cwd) 由 semaclaw 按 binding.folder 设置，多人设场景下天然唯一。
    // 允许中文/日韩字符，仅替换文件系统非法字符；长度截断防极端命名。
    const personaTag = String(path.basename(cwd || '') || agentId)
      .replace(/[/\\:*?"<>|\x00-\x1f]/g, '_')
      .slice(0, 80) || 'unknown';
    const dir = path.join(cwd, 'hook-history');
    fs.mkdirSync(dir, { recursive: true });

    let filePath;
    if (isPreCompact) {
      filePath = path.join(dir, `Precompact-${makeStamp()}-${personaTag}.md`);
      const md = renderMarkdown({ agentId, sessionId, stopReason, eventName, payload, history });
      fs.writeFileSync(filePath, md, 'utf8');
      writeRawLLMSnapshot(filePath, sessionId);
      process.exit(0);
    }

    const indexPath = path.join(dir, `.${personaTag}.last.json`);
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
      filePath = path.join(dir, `${makeStamp()}-${personaTag}.md`);
    }

    const md = renderMarkdown({ agentId, sessionId, stopReason, eventName, payload, history });
    fs.writeFileSync(filePath, md, 'utf8');
    writeIndex(indexPath, { filePath, count: history.length, lastUuid: currentLastUuid || null });
    writeRawLLMSnapshot(filePath, sessionId);
    process.exit(0);
  } catch (err) {
    console.error(`[save-history] failed: ${err && err.message ? err.message : err}`);
    process.exit(1);
  }
});

// ---------- raw LLM request snapshot ----------

function writeRawLLMSnapshot(mdPath, sessionId) {
  try {
    const logFile = findSemaLLMLogFile(sessionId);
    if (!logFile) return;
    const snapshot = extractLatestRequest(logFile);
    if (!snapshot) return;
    const jsonPath = mdPath.replace(/\.md$/, '.json');
    const out = {
      source: logFile,
      session_id: sessionId || null,
      request_at: snapshot.request.timestamp,
      request: snapshot.request.data,
      response_at: snapshot.response ? snapshot.response.timestamp : null,
      response: snapshot.response ? snapshot.response.data : null,
    };
    fs.writeFileSync(jsonPath, JSON.stringify(out, null, 2), 'utf8');
  } catch (err) {
    // non-fatal — md is the primary artifact
    console.error(`[save-history] raw snapshot skipped: ${err && err.message ? err.message : err}`);
  }
}

function findSemaLLMLogFile(sessionId) {
  if (!fs.existsSync(SEMA_LLM_LOGS_DIR)) return null;
  const today = new Date();
  const pad = n => String(n).padStart(2, '0');
  const datePrefix = `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`;

  const candidates = fs.readdirSync(SEMA_LLM_LOGS_DIR)
    .filter(f => f.endsWith('.log'))
    .map(f => ({ name: f, full: path.join(SEMA_LLM_LOGS_DIR, f) }));

  // 1) exact match: today + sessionId
  if (sessionId) {
    const exact = candidates.find(c =>
      c.name.startsWith(datePrefix) && c.name.includes(sessionId)
    );
    if (exact) return exact.full;
    // 2) any-date match for sessionId (covers cross-midnight sessions)
    const sess = candidates.find(c => c.name.includes(sessionId));
    if (sess) return sess.full;
  }
  // 3) fallback: most-recently-modified file from today
  const todayFiles = candidates
    .filter(c => c.name.startsWith(datePrefix))
    .map(c => ({ ...c, mtime: fs.statSync(c.full).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  return todayFiles[0] ? todayFiles[0].full : null;
}

function extractLatestRequest(logPath) {
  const content = fs.readFileSync(logPath, 'utf8');
  const lines = content.split('\n');
  const entries = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    const m = line.match(/^\[(\d{2}:\d{2}:\d{2})\](.+)$/);
    if (!m) continue;
    let data;
    try { data = JSON.parse(m[2]); } catch { continue; }
    const isRequest = Array.isArray(data.messages);
    entries.push({ timestamp: m[1], data, isRequest });
  }

  // Prefer the request whose `messages` array is longest. Because sema
  // resends the full conversation every turn, the longest request is also
  // the most recent main-conversation snapshot, and quick-model requests
  // (short messages) lose the comparison automatically. Tie-break by later
  // position in the file (i.e. newer).
  let bestIdx = -1;
  let bestLen = -1;
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (!e.isRequest) continue;
    const len = e.data.messages.length;
    if (len > bestLen || (len === bestLen && i > bestIdx)) {
      bestLen = len;
      bestIdx = i;
    }
  }
  if (bestIdx < 0) return null;

  let response = null;
  for (let j = bestIdx + 1; j < entries.length; j++) {
    if (!entries[j].isRequest) { response = entries[j]; break; }
  }
  return { request: entries[bestIdx], response };
}

// ---------- markdown rendering ----------

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
  if (content == null) { lines.push('_(no content)_'); return; }
  if (typeof content === 'string') { lines.push(truncate(content)); return; }
  if (!Array.isArray(content)) {
    lines.push('```json'); lines.push(safeStringify(content)); lines.push('```'); return;
  }
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    switch (block.type) {
      case 'text':
        lines.push(truncate(block.text || '')); lines.push(''); break;
      case 'thinking':
        lines.push('<details><summary>thinking</summary>'); lines.push('');
        lines.push(truncate(block.thinking || '')); lines.push('');
        lines.push('</details>'); lines.push(''); break;
      case 'tool_use':
        lines.push(`### tool_use: \`${block.name}\` (id: \`${block.id}\`)`); lines.push('');
        lines.push('```json'); lines.push(truncate(safeStringify(block.input))); lines.push('```'); lines.push(''); break;
      case 'tool_result':
        lines.push(`### tool_result (id: \`${block.tool_use_id}\`)${block.is_error ? ' [ERROR]' : ''}`); lines.push('');
        renderToolResult(block.content, lines); lines.push(''); break;
      case 'image':
        lines.push('_[image block omitted]_'); lines.push(''); break;
      default:
        lines.push(`_(unknown block type: ${block.type})_`);
        lines.push('```json'); lines.push(truncate(safeStringify(block))); lines.push('```'); lines.push('');
    }
  }
}

function renderToolResult(content, lines) {
  if (typeof content === 'string') {
    lines.push('```'); lines.push(truncate(content)); lines.push('```'); return;
  }
  if (Array.isArray(content)) {
    for (const sub of content) {
      if (sub && sub.type === 'text') {
        lines.push('```'); lines.push(truncate(sub.text || '')); lines.push('```');
      } else if (sub && sub.type === 'image') {
        lines.push('_[image]_');
      } else {
        lines.push('```json'); lines.push(truncate(safeStringify(sub))); lines.push('```');
      }
    }
    return;
  }
  lines.push('```json'); lines.push(truncate(safeStringify(content))); lines.push('```');
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
function lastUuid(history) { return uuidAt(history, history.length - 1); }
function readIndex(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } }
function writeIndex(p, data) { try { fs.writeFileSync(p, JSON.stringify(data), 'utf8'); } catch {} }
