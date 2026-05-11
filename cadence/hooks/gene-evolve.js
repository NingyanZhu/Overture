#!/usr/bin/env node
// Stop hook (async, include_history=true): distil reusable atomic constraints
// from the just-finished conversation slice and append them to the wiki under
// `Agent Genes/<task_domain>.md`.
//
// Pipeline:
//   1. sentinel + lock — bail on recursion or concurrent runs
//   2. slice — find last real user message (toolUseResult===undefined) and
//      take everything after it as the current user-turn (4.4.1)
//   3. trigger — 2-of-3 of {turns≥15, Σ durationMs≥180s, keyword hits} (4.4.2/4.4.3)
//   4. fold  — collapse the slice to a <4KB compact timeline (4.4.4)
//   5. distil — call `semaclaw agent-task --output json` with a fully-built prompt
//   6. post  — schema check / Jaccard dedup / mkdir new domain / append to wiki / evolve-log
//
// Hook *never* blocks the user: every error path → exit 0 with stderr log.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');
const weights = require('./weights');
const seed = require('./seed');

const PLUGIN_ROOT = path.dirname(path.dirname(__filename));
const SEMACLAW_ROOT = process.env.SEMACLAW_ROOT || path.join(os.homedir(), '.semaclaw');
const LOCK_DIR = path.join(SEMACLAW_ROOT, 'locks');
const LOCK_PATH = path.join(LOCK_DIR, 'gene-evolve.lock');
const LOG_DIR = path.join(SEMACLAW_ROOT, 'logs', 'gene-evolve');

function loadJsonRel(rel, fallback) {
  try { return JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, rel), 'utf8')); }
  catch { return fallback; }
}
const CONFIG = loadJsonRel('gene-categories.json', {});
const KEYWORDS = loadJsonRel('keywords.json', {});
const TRIGGER = CONFIG.trigger || {};
const EVOLVE = CONFIG.evolve || {};
const MIN_MESSAGE_LENGTH = TRIGGER.message_length ?? 20;
const MIN_DURATION_MS = TRIGGER.min_assistant_duration_ms ?? 180000;
const C2_THRESHOLD = TRIGGER.c2_distinct_keywords ?? 3;
const MAX_GENES_PER_CALL = EVOLVE.max_genes_per_call ?? 3;
const MIN_CONFIDENCE = EVOLVE.min_confidence ?? 0.6;
const JACCARD_DEDUP = EVOLVE.jaccard_dedup_threshold ?? 0.7;
const HISTORY_MAX_CHARS = EVOLVE.history_fold_max_chars ?? 4000;
const CLI_TIMEOUT_MS = EVOLVE.cli_timeout_ms ?? 180000;
const TOOLS = EVOLVE.tools_whitelist ?? 'Read,Glob,Grep,Skill';

function getWikiDir() {
  if (process.env.WIKI_DIR) return process.env.WIKI_DIR;
  return path.join(os.homedir(), 'semaclaw', 'wiki');
}

// ───────── lock ─────────

function acquireLock(lockPath = LOCK_PATH) {
  try { fs.mkdirSync(path.dirname(lockPath), { recursive: true }); } catch {}
  try {
    const fd = fs.openSync(lockPath, 'wx');
    fs.writeSync(fd, String(process.pid));
    fs.closeSync(fd);
    return true;
  } catch (e) {
    if (e.code === 'EEXIST') {
      // Stale lock recovery, two paths:
      //   1) PID liveness — if the recorded pid is gone, the previous run crashed
      //      between acquire and release; reclaim immediately (no wait).
      //   2) mtime fallback — > 10min old → take over. Bounds a normal run at
      //      cli_timeout_ms (3min) + spawnSync wrap (~3.5min); 10min has headroom.
      try {
        const raw = fs.readFileSync(lockPath, 'utf8').trim();
        const heldPid = parseInt(raw, 10);
        if (heldPid > 0 && heldPid !== process.pid) {
          try {
            process.kill(heldPid, 0); // signal 0 = liveness probe
          } catch (probeErr) {
            if (probeErr.code === 'ESRCH') {
              fs.unlinkSync(lockPath);
              return acquireLock(lockPath);
            }
            // EPERM means a process with that pid exists but we can't signal it;
            // treat as alive and fall through to the mtime check.
          }
        }
      } catch {}
      try {
        const st = fs.statSync(lockPath);
        if (Date.now() - st.mtimeMs > 10 * 60 * 1000) {
          fs.unlinkSync(lockPath);
          return acquireLock(lockPath);
        }
      } catch {}
    }
    return false;
  }
}
function releaseLock() {
  try { fs.unlinkSync(LOCK_PATH); } catch {}
}

// ───────── stdin payload ─────────

function readStdinSync() {
  try { return fs.readFileSync(0, 'utf8'); } catch { return ''; }
}

// ───────── slice ─────────

function isRealUserMessage(m) {
  // sema-core UserMessage with toolUseResult===undefined is a real user msg;
  // tool_result wrapping carries toolUseResult set.
  if (!m) return false;
  const role = m.type || (m.message && m.message.role);
  if (role !== 'user') return false;
  return m.toolUseResult === undefined && (m.message ? m.message.toolUseResult === undefined : true);
}

function extractSlice(history) {
  if (!Array.isArray(history) || history.length === 0) return [];
  for (let i = history.length - 1; i >= 0; i--) {
    if (isRealUserMessage(history[i])) return history.slice(i);
  }
  return [];
}

// ───────── trigger judgment ─────────

function countMessages(slice) {
  // Total message count in the slice (real-user / tool_result-wrapper / assistant
  // all count). NOT the same as "interaction turns" — one assistant reply with
  // 3 tool calls contributes ~7 messages. Named "message_length" in config to
  // make this explicit.
  return slice.length;
}

function sumAssistantDurationMs(slice) {
  let sum = 0;
  for (const m of slice) {
    const role = m.type || (m.message && m.message.role);
    if (role !== 'assistant') continue;
    const d = (m.durationMs ?? (m.message && m.message.durationMs)) || 0;
    if (typeof d === 'number') sum += d;
  }
  return sum;
}

function flattenTextOfMessage(m) {
  const inner = m.message || m;
  const c = inner.content;
  if (typeof c === 'string') return c;
  if (!Array.isArray(c)) return '';
  const parts = [];
  for (const b of c) {
    if (!b || typeof b !== 'object') continue;
    if (b.type === 'text') parts.push(b.text || '');
    else if (b.type === 'thinking') parts.push(b.thinking || '');
    else if (b.type === 'tool_use') {
      parts.push(b.name || '');
      try { parts.push(JSON.stringify(b.input || {})); } catch {}
    } else if (b.type === 'tool_result') {
      const cc = b.content;
      if (typeof cc === 'string') parts.push(cc);
      else if (Array.isArray(cc)) for (const sub of cc) if (sub && sub.type === 'text') parts.push(sub.text || '');
    }
  }
  return parts.join('\n');
}

function matchAnyEn(text, words) {
  const lower = text.toLowerCase();
  const hits = new Set();
  for (const w of words) {
    if (!w) continue;
    if (/[\s-]/.test(w)) {
      if (lower.includes(w.toLowerCase())) hits.add(w);
    } else {
      const re = new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
      if (re.test(text)) hits.add(w);
    }
  }
  return hits;
}
function matchAnyZh(text, words) {
  const hits = new Set();
  for (const w of words) {
    if (!w) continue;
    if (text.includes(w)) hits.add(w);
  }
  return hits;
}
function matchCategory(text, vocab) {
  if (!vocab) return new Set();
  const en = matchAnyEn(text, vocab.en || []);
  const zh = matchAnyZh(text, vocab.zh || []);
  return new Set([...en, ...zh]);
}

function judgeTrigger(slice, turnDurationMs) {
  const messageLength = countMessages(slice);
  // 优先使用 sema-core 通过 StopHookInput.turn_duration_ms 注入的 wall-clock，
  // 它包含工具执行 + 等待时间，是"用户在这轮折腾了多久"的真实度量。
  // 老版本 sema-core 不带此字段时退回累加 message.durationMs（仅 API 时间和，会偏低）。
  const durationMs = (typeof turnDurationMs === 'number' && turnDurationMs > 0)
    ? turnDurationMs
    : sumAssistantDurationMs(slice);
  const durationSource = (typeof turnDurationMs === 'number' && turnDurationMs > 0)
    ? 'turn_duration_ms'
    : 'sum_message_durationMs';

  const aHit = messageLength >= MIN_MESSAGE_LENGTH;
  const bHit = durationMs >= MIN_DURATION_MS;

  // C: keyword scan
  let realUserText = '';
  let allText = '';
  for (const m of slice) {
    const t = flattenTextOfMessage(m);
    allText += '\n' + t;
    if (isRealUserMessage(m)) realUserText += '\n' + t;
  }

  const dissatHits = matchCategory(realUserText, KEYWORDS.user_dissatisfaction);
  const c1 = dissatHits.size >= 1;

  const all = new Set([
    ...matchCategory(allText, KEYWORDS.user_dissatisfaction),
    ...matchCategory(allText, KEYWORDS.external_failure),
    ...matchCategory(allText, KEYWORDS.self_correction),
    ...matchCategory(allText, KEYWORDS.inefficient_pattern),
  ]);
  const c2 = all.size >= C2_THRESHOLD;

  const cHit = c1 || c2;

  const score = (aHit ? 1 : 0) + (bHit ? 1 : 0) + (cHit ? 1 : 0);
  return {
    fire: score >= 2,
    messageLength, durationMs, durationSource,
    aHit, bHit, cHit, c1, c2,
    keywordHits: Array.from(all),
    realUserText: realUserText.trim().slice(0, 500),
  };
}

// ───────── history fold ─────────

function clip(s, n) {
  if (typeof s !== 'string') s = String(s == null ? '' : s);
  if (s.length <= n) return s;
  return s.slice(0, n) + `…[+${s.length - n}]`;
}

function summarizeToolInput(_name, input) {
  if (!input || typeof input !== 'object') return '';
  const keys = ['command', 'file_path', 'pattern', 'path', 'query', 'url'];
  for (const k of keys) {
    if (typeof input[k] === 'string') return `${k}=${clip(input[k], 200)}`;
  }
  try { return clip(JSON.stringify(input), 200); } catch { return ''; }
}

function isErrorish(text) {
  if (!text) return false;
  const lower = text.toLowerCase();
  const failVocab = (KEYWORDS.external_failure && KEYWORDS.external_failure.en) || [];
  for (const w of failVocab) {
    if (!w) continue;
    if (lower.includes(w.toLowerCase())) return true;
  }
  return false;
}

function foldHistory(slice) {
  const lines = [];
  let used = 0;
  function push(s) {
    if (used >= HISTORY_MAX_CHARS) return;
    const remaining = HISTORY_MAX_CHARS - used;
    const out = s.length > remaining ? s.slice(0, remaining) + '…' : s;
    lines.push(out);
    used += out.length + 1;
  }

  for (const m of slice) {
    const role = m.type || (m.message && m.message.role);
    const inner = m.message || m;
    const c = inner.content;

    if (role === 'user' && isRealUserMessage(m)) {
      // strip system-injected blocks (system-reminder / command-name / etc.)
      let text = typeof c === 'string' ? c
        : Array.isArray(c) ? c.filter(b => b && b.type === 'text').map(b => b.text || '').join('\n')
        : '';
      text = text
        .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
        .replace(/<command-name>[\s\S]*?<\/command-name>/g, '')
        .replace(/<command-message>[\s\S]*?<\/command-message>/g, '')
        .replace(/<command-args>[\s\S]*?<\/command-args>/g, '')
        .replace(/<local-command-stdout>[\s\S]*?<\/local-command-stdout>/g, '')
        .replace(/<agent-genes>[\s\S]*?<\/agent-genes>/g, '');
      text = text.split('\n\n')[0]; // first paragraph only
      push(`USER: ${clip(text.trim(), 600)}`);
      continue;
    }

    if (role === 'assistant') {
      if (!Array.isArray(c)) {
        if (typeof c === 'string' && c.trim()) push(`ASSISTANT: ${clip(c.trim(), 400)}`);
        continue;
      }
      for (const b of c) {
        if (!b || typeof b !== 'object') continue;
        if (b.type === 'thinking' && b.thinking) {
          push(`ASSISTANT[think]: ${clip(b.thinking.trim(), 300)}`);
        } else if (b.type === 'text' && b.text) {
          push(`ASSISTANT: ${clip(b.text.trim(), 400)}`);
        } else if (b.type === 'tool_use') {
          push(`TOOL: ${b.name || '?'}(${summarizeToolInput(b.name, b.input)})`);
        }
      }
      continue;
    }

    // role === 'user' but it's a tool_result wrapper
    if (Array.isArray(c)) {
      for (const b of c) {
        if (!b || typeof b !== 'object') continue;
        if (b.type !== 'tool_result') continue;
        let resultText = '';
        if (typeof b.content === 'string') resultText = b.content;
        else if (Array.isArray(b.content))
          resultText = b.content.filter(s => s && s.type === 'text').map(s => s.text || '').join('\n');
        if (b.is_error) {
          push(`  → ERROR ${clip(resultText, 500)}`);
        } else if (isErrorish(resultText)) {
          // surface error-like lines from stdout/stderr even if is_error not set
          const errLines = resultText.split('\n').filter(l => isErrorish(l)).slice(0, 3);
          push(`  → [issue] ${clip(errLines.join(' | '), 400)}`);
        } else {
          push(`  → OK ${clip(String(resultText).length, 0)} chars`);
        }
      }
    }
  }

  return lines.join('\n');
}

// ───────── prompt assembly ─────────

function listExistingDomains() {
  const root = path.join(getWikiDir(), 'Agent Genes');
  if (!fs.existsSync(root)) return [];
  const out = [];
  function walk(dir, prefix) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.isDirectory()) walk(full, rel);
      else if (e.isFile() && e.name.endsWith('.md')) {
        out.push(rel.replace(/\.md$/, ''));
      }
    }
  }
  walk(root, '');
  return out;
}

function loadAllGenes() {
  const root = path.join(getWikiDir(), 'Agent Genes');
  const out = [];
  if (!fs.existsSync(root)) return out;
  function walk(dir) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile() && e.name.endsWith('.md')) {
        for (const g of parseGenesFile(full, root)) out.push(g);
      }
    }
  }
  walk(root);
  return out;
}

function parseGenesFile(filePath, wikiGenesRoot) {
  let content;
  try { content = fs.readFileSync(filePath, 'utf8'); } catch { return []; }
  let body = content;
  if (body.startsWith('---')) {
    const end = body.indexOf('\n---', 3);
    if (end >= 0) body = body.slice(end + 4);
  }
  const rel = path.relative(wikiGenesRoot, filePath).replace(/\.md$/, '').replace(/\\/g, '/');
  const blocks = body.split(/^## /m).slice(1);
  const genes = [];
  for (const blk of blocks) {
    const lines = blk.split('\n');
    const name = (lines.shift() || '').trim();
    if (!name) continue;
    let intent = [];
    let bodyLines = [];
    for (const line of lines) {
      const m = line.match(/^intent:\s*\[(.*?)\]\s*$/);
      if (m && intent.length === 0) {
        intent = m[1].split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
      } else {
        bodyLines.push(line);
      }
    }
    const text = bodyLines.join('\n').trim();
    if (!text || intent.length === 0) continue;
    genes.push({ task_domain: rel, name, intent, text });
  }
  return genes;
}

function topRelevantGenes(realUserText, n) {
  const all = loadAllGenes();
  if (all.length === 0) return [];
  const kw = new Set();
  const lower = realUserText.toLowerCase();
  for (const m of (lower.match(/[a-z][a-z0-9_-]{2,}/g) || [])) kw.add(m);
  const zhFrags = lower.replace(/[^一-鿿]+/g, ' ').trim().split(/\s+/).filter(Boolean);
  for (const seg of zhFrags) for (let i = 0; i < seg.length; i++) {
    if (i + 2 <= seg.length) kw.add(seg.slice(i, i + 2));
  }
  const scored = all.map(g => {
    let hit = 0;
    for (const k of g.intent) {
      if (kw.has(k)) hit++;
      else { for (const p of kw) if (p.length >= 2 && (k.includes(p) || p.includes(k))) { hit++; break; } }
    }
    return { g, s: hit / Math.max(g.intent.length, 1) };
  });
  return scored.sort((a, b) => b.s - a.s).slice(0, n).filter(x => x.s > 0).map(x => x.g);
}

function buildTaskPrompt({ folded, domains, topGenes, triggerSummary }) {
  const domainList = domains.length ? domains.map(d => `- ${d}`).join('\n') : '(none yet — feel free to propose new domains)';
  const existing = topGenes.length
    ? topGenes.map(g => `- [${g.task_domain}] ${g.name}: ${g.text.replace(/\s+/g, ' ').trim()}`).join('\n')
    : '(none relevant)';

  return [
    'You are a reflection agent. Your job is to read a finished conversation slice and distil at most ' + MAX_GENES_PER_CALL + ' atomic constraints ("genes") that, if followed next time, would prevent observed mistakes or repeat observed wins.',
    '',
    'STRICT OUTPUT RULES:',
    '- Output a single JSON object, nothing else (no prose, no markdown fence required but allowed).',
    '- Schema: { "genes": [ { "task_domain": "<Cat>/<Sub>", "is_new_domain": false, "keywords": ["...", ...], "gene_body": "AVOID: ..." | "DO: ...", "confidence": 0.0, "reasoning_brief": "<=50 words" } ] }',
    '- "genes" array length MUST be ≤ ' + MAX_GENES_PER_CALL + '. Empty array allowed if nothing useful to extract.',
    '- "gene_body" MUST be ONE LINE, ≤ 75 words, starting with "AVOID:" or "DO:". No examples, no story, no source. Pure constraint.',
    '- "keywords" MUST be lowercase short tokens capturing the *intent* of the gene (used for purely string-level retrieval at inject time — no embeddings, no translation).',
    '  · CRITICAL — TASK-DESCRIPTION VOCABULARY ONLY: keywords must be words a USER would actually TYPE when describing their problem or request ("怎么调试 auth 失败", "帮我调研一下…"). The retriever string-matches against raw user prompts, so architectural / design-pattern jargon that users don\'t naturally say will never fire and is wasted budget.',
    '    GOOD: action verbs ("debug", "调试", "deploy", "部署", "research", "调研"), error symptoms ("timeout", "crash", "超时", "崩溃", "报错"), concrete topics ("auth", "token", "鉴权", "性能"), tool / lib / domain names ("git", "docker", "redis", "前端").',
    '    BAD (do NOT use): "boundary" / "边界", "reuse" / "复用", "rate-limit" / "限流", "abstraction" / "抽象", "encapsulation" / "封装", "fallback" / "兜底", "singleton" / "单例", "drive-by", "premature", "speculative" — these are labels an architect would write on a whiteboard, not what a user types when asking for help.',
    '  · ALWAYS include 3–6 English keywords (lingua franca for cross-language retrieval and tooling/code terms).',
    '  · IF the conversation primarily uses another language (Chinese / Japanese / Korean / etc.), ALSO include 3–6 keywords in that language alongside the English ones, so users prompting in their own language still match this gene.',
    '  · Total length: 3–12. Examples: ["auth", "token", "debug"] for English-only conversations; ["auth", "token", "debug", "鉴权", "令牌", "调试"] for an EN/ZH conversation.',
    '- "task_domain" MUST be of the form "<Category>/<Subcategory>", depth=2. Use an existing domain when it fits; only set is_new_domain=true if you genuinely need a new one.',
    '- "confidence" ∈ [0, 1]; we only persist genes with confidence ≥ ' + MIN_CONFIDENCE + '.',
    '- Prefer AVOID over DO. Failures distil more cleanly than successes.',
    '',
    'EXISTING DOMAINS (re-use when applicable):',
    domainList,
    '',
    'TOP RELEVANT EXISTING GENES (DO NOT duplicate or rephrase these):',
    existing,
    '',
    'TRIGGER CONTEXT (why this conversation was selected):',
    `- messages: ${triggerSummary.messageLength}, assistant duration: ${(triggerSummary.durationMs / 1000).toFixed(1)}s`,
    `- C1 (user dissatisfaction): ${triggerSummary.c1}, C2 (≥${C2_THRESHOLD} distinct error/correction keywords): ${triggerSummary.c2}`,
    `- keyword hits: ${triggerSummary.keywordHits.slice(0, 12).join(', ') || '(none)'}`,
    '',
    'EVIDENCE SOURCE:',
    '- The folded conversation timeline below is your PRIMARY (and usually sufficient) source — distil from it.',
    '- Optional escalation: if you need to confirm a pattern is recurring vs. a one-off, past session snapshots may be available at `./hook-history/*.md` (or `**/hook-history/*.md` if cwd is elsewhere) saved by the notation plugin. Glob/Grep/Read them ONLY when the current slice cannot resolve "habit vs. one-off". Default behavior is to ignore them — every cross-session lookup costs latency and token budget.',
    '',
    'CONVERSATION TIMELINE (folded):',
    '```',
    folded,
    '```',
    '',
    'Now produce the JSON. No preamble.',
  ].join('\n');
}

// ───────── stdout JSON salvage ─────────

// `semaclaw agent-task --output json` is supposed to keep stdout pure, but it
// occasionally leaks log lines (skill loader warnings, "session done in 50ms",
// etc.) before the JSON payload. Strict JSON.parse then drops a perfectly good
// gene. This salvages the trailing JSON object from any prefix noise.
//
// Approach: walk forward, collect every top-level balanced `{...}` substring
// (string-aware so braces inside JSON strings don't count), then try them
// last-first, accepting the first one whose shape matches { genes: [...] }.
// Regex won't work because gene_body strings can legitimately contain `{`/`}`.
function extractTrailingJsonObject(stdout) {
  if (typeof stdout !== 'string' || !stdout.includes('{')) return null;
  const candidates = [];
  let i = 0;
  while (i < stdout.length) {
    const start = stdout.indexOf('{', i);
    if (start < 0) break;
    let depth = 0;
    let inStr = false;
    let esc = false;
    let end = -1;
    for (let j = start; j < stdout.length; j++) {
      const c = stdout[j];
      if (esc) { esc = false; continue; }
      if (inStr) {
        if (c === '\\') { esc = true; continue; }
        if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') { inStr = true; continue; }
      if (c === '{') depth++;
      else if (c === '}') {
        depth--;
        if (depth === 0) { end = j; break; }
      }
    }
    if (end < 0) break; // unbalanced from this `{` onward → give up
    candidates.push({ s: stdout.slice(start, end + 1), at: start });
    i = end + 1;
  }
  for (let k = candidates.length - 1; k >= 0; k--) {
    try {
      const p = JSON.parse(candidates[k].s);
      if (p && typeof p === 'object' && Array.isArray(p.genes)) {
        return { value: p, at: candidates[k].at };
      }
    } catch {}
  }
  return null;
}

// ───────── post-processing ─────────

function jaccard(a, b) {
  const A = new Set(a.map(s => String(s).toLowerCase()));
  const B = new Set(b.map(s => String(s).toLowerCase()));
  if (A.size === 0 && B.size === 0) return 1;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  const uni = A.size + B.size - inter;
  return uni === 0 ? 0 : inter / uni;
}

function sanitizeDomain(d) {
  if (typeof d !== 'string') return null;
  if (!/^[A-Za-z0-9 _\-/]+$/.test(d)) return null;
  const parts = d.split('/').map(p => p.trim()).filter(Boolean);
  if (parts.length < 1 || parts.length > 2) return null;
  return parts.join('/');
}

function sanitizeBody(b) {
  if (typeof b !== 'string') return null;
  const one = b.replace(/\s+/g, ' ').trim();
  if (!/^(AVOID|DO):/i.test(one)) return null;
  // ≤ ~25 words; allow some slack
  const words = one.split(' ').length;
  if (words > 35) return null;
  return one;
}

function ensureWikiDir(domain) {
  const target = path.join(getWikiDir(), 'Agent Genes', domain + '.md');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  if (!fs.existsSync(target)) {
    const fm = [
      '---',
      `category: ${domain}`,
      `tags: []`,
      `updated: ${new Date().toISOString()}`,
      '---',
      '',
    ].join('\n');
    fs.writeFileSync(target, fm, 'utf8');
  }
  return target;
}

function appendGene(filePath, gene) {
  const slug = (gene.keywords[0] || 'gene').toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 24);
  const ts = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const name = `${slug}-${ts}-${Math.random().toString(36).slice(2, 6)}`;
  const block = [
    '',
    `## ${name}`,
    `intent: [${gene.keywords.join(', ')}]`,
    gene.gene_body,
    '',
  ].join('\n');
  fs.appendFileSync(filePath, block, 'utf8');
  return name;
}

function writeEvolveLog(record) {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    const day = new Date().toISOString().slice(0, 10);
    fs.appendFileSync(path.join(LOG_DIR, `${day}.jsonl`), JSON.stringify(record) + '\n', 'utf8');
  } catch {}
}

// ───────── main ─────────

function main() {
  // 必须先把 stdin 读完再做任何 process.exit。否则父进程（sema-core CommandExecutor）
  // 还在向我们 stdin 里写大 payload 时，我们已退出，父进程 write 触发 EPIPE 未捕获
  // 直接崩掉 daemon。sema-core 侧根本修复要在 CommandExecutor.spawn 之后挂
  // proc.stdin.on('error', () => {})，但这条流水线先在 hook 内消除触发条件。
  const stdin = readStdinSync();

  if (process.env.SEMACLAW_INTERNAL_AGENT === '1') {
    process.exit(0);
  }
  // First-time seed: only when `Agent Genes/` doesn't exist yet (idempotent, cheap)
  try { seed.ensureFirstTimeSeeds({ wikiDir: getWikiDir(), pluginRoot: PLUGIN_ROOT }); } catch {}
  if (!acquireLock()) {
    process.stderr.write('[gene-evolve] another run holds the lock; skipping\n');
    process.exit(0);
  }
  let record = { ts: new Date().toISOString(), stage: 'start' };
  try {
    const t0 = Date.now();
    const payload = stdin ? JSON.parse(stdin) : {};
    const history = Array.isArray(payload.conversation_history) ? payload.conversation_history
      : Array.isArray(payload.context_history) ? payload.context_history : [];
    record.session_id = payload.session_id || null;
    record.agent_id = payload.agent_id || null;
    record.history_len = history.length;

    const slice = extractSlice(history);
    record.slice_len = slice.length;
    if (slice.length === 0) {
      record.stage = 'no-slice';
      writeEvolveLog(record);
      process.exit(0);
    }

    // turn_duration_ms 由 sema-core StopHookInput 注入；旧版本 sema-core 没此字段，
    // judgeTrigger 内部会自动 fallback 到累加 message.durationMs。
    const trig = judgeTrigger(slice, payload.turn_duration_ms);
    record.trigger = {
      fire: trig.fire, messageLength: trig.messageLength,
      durationMs: trig.durationMs, durationSource: trig.durationSource,
      aHit: trig.aHit, bHit: trig.bHit, cHit: trig.cHit,
      keywordHits: trig.keywordHits,
    };
    if (!trig.fire) {
      record.stage = 'not-triggered';
      writeEvolveLog(record);
      process.exit(0);
    }

    const folded = foldHistory(slice);
    const domains = listExistingDomains();
    const topGenes = topRelevantGenes(trig.realUserText, 20);
    const promptText = buildTaskPrompt({
      folded, domains, topGenes, triggerSummary: trig,
    });

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cadence-evolve-'));
    const promptFile = path.join(tmpDir, 'prompt.md');
    fs.writeFileSync(promptFile, promptText, 'utf8');
    record.prompt_chars = promptText.length;

    const cliBin = process.env.SEMACLAW_BIN || 'semaclaw';
    record.cli_bin = cliBin;
    record.cli_bin_source = process.env.SEMACLAW_BIN ? 'env' : 'path-fallback';
    if (!process.env.SEMACLAW_BIN) {
      process.stderr.write('[gene-evolve] SEMACLAW_BIN not set; falling back to `semaclaw` on PATH\n');
    }
    const args = [
      'agent-task',
      '--prompt-file', promptFile,
      '--tools', TOOLS,
      '--output', 'json',
      '--timeout', String(CLI_TIMEOUT_MS),
      '--instance-id', `cadence-evolve-${Date.now()}`,
    ];
    // Run via the entry node found on PATH if SEMACLAW_BIN points at a JS file (dev mode).
    let runCmd, runArgs;
    if (cliBin.endsWith('.ts')) {
      runCmd = 'npx';
      runArgs = ['tsx', cliBin, ...args];
    } else if (cliBin.endsWith('.js')) {
      runCmd = process.execPath;
      runArgs = [cliBin, ...args];
    } else {
      runCmd = cliBin;
      runArgs = args;
    }

    const proc = spawnSync(runCmd, runArgs, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, SEMACLAW_INTERNAL_AGENT: '1' },
      timeout: CLI_TIMEOUT_MS + 30000,
    });
    record.cli_exit = proc.status;
    record.cli_signal = proc.signal || null;
    record.duration_ms = Date.now() - t0;

    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}

    // 外圈 spawnSync timeout 把子进程 SIGTERM 时：status=null, signal='SIGTERM'。
    // 单独分流，方便 grep 日志定位是不是被 kill 的。
    if (proc.status === null && proc.signal) {
      record.stage = 'cli-timeout';
      record.stderr_tail = (proc.stderr || '').toString().slice(-500);
      writeEvolveLog(record);
      process.exit(0);
    }

    // CLI 自身用 exit 3 表示 "--output json 拿到的不是 JSON"，
    // raw text 在 stderr 里（agent-task.ts 是 console.error 出去的）。
    if (proc.status === 3) {
      record.stage = 'cli-not-json';
      record.stderr_tail = (proc.stderr || '').toString().slice(-500);
      record.stdout_tail = (proc.stdout || '').toString().slice(-500);
      writeEvolveLog(record);
      process.exit(0);
    }

    if (proc.status !== 0) {
      record.stage = 'cli-failed';
      record.stderr_tail = (proc.stderr || '').toString().slice(-500);
      record.stdout_tail = (proc.stdout || '').toString().slice(-500);
      writeEvolveLog(record);
      process.exit(0);
    }

    let parsed;
    const stdoutStr = (proc.stdout || '').toString();
    try { parsed = JSON.parse(stdoutStr); }
    catch (e) {
      // Fast-path JSON.parse failed. The usual culprit is `semaclaw agent-task`
      // leaking log lines onto stdout in `--output json` mode (skill-loader
      // warnings, "session done in 50ms", etc.). Try to salvage the trailing
      // JSON object before declaring failure.
      const rec = extractTrailingJsonObject(stdoutStr);
      if (rec) {
        parsed = rec.value;
        record.cli_stdout_salvaged = true;
        record.salvage_prefix_bytes = rec.at;
      } else {
        record.stage = 'cli-bad-json';
        record.stdout_tail = stdoutStr.slice(-500);
        record.stderr_tail = (proc.stderr || '').toString().slice(-500);
        writeEvolveLog(record);
        process.exit(0);
      }
    }

    const proposedGenes = Array.isArray(parsed && parsed.genes) ? parsed.genes : [];
    record.proposed = proposedGenes.length;
    const accepted = [];
    const skipped = [];
    const allExisting = loadAllGenes();

    for (const raw of proposedGenes.slice(0, MAX_GENES_PER_CALL)) {
      const reason = (msg) => skipped.push({ name: raw && raw.gene_body, reason: msg });

      if (!raw || typeof raw !== 'object') { reason('not-object'); continue; }
      const conf = typeof raw.confidence === 'number' ? raw.confidence : -1;
      if (conf < MIN_CONFIDENCE) { reason(`low-conf:${conf}`); continue; }

      const domain = sanitizeDomain(raw.task_domain);
      if (!domain) { reason('bad-domain'); continue; }
      const body = sanitizeBody(raw.gene_body);
      if (!body) { reason('bad-body'); continue; }

      const kwArr = Array.isArray(raw.keywords) ? raw.keywords.map(k => String(k).toLowerCase()).filter(Boolean) : [];
      if (kwArr.length < 3 || kwArr.length > 12) { reason(`bad-keywords:${kwArr.length}`); continue; }

      const sameDomain = allExisting.filter(g => g.task_domain === domain);
      let dup = false;
      for (const e of sameDomain) {
        if (jaccard(kwArr, e.intent) >= JACCARD_DEDUP) { dup = true; break; }
      }
      if (dup) { reason('jaccard-dup'); continue; }

      const target = ensureWikiDir(domain);
      const gene = { task_domain: domain, gene_body: body, keywords: kwArr, confidence: conf };
      const newName = appendGene(target, gene);
      // also push into in-memory existing list to dedup within the same batch
      allExisting.push({ task_domain: domain, intent: kwArr, name: '_pending', text: body });
      accepted.push({ ...gene, name: newName });
    }

    // Initialize weight sidecar entries so freshly-distilled genes start at base 1.0
    // with last_hit=now (so they compete fairly against veterans on the next inject).
    if (accepted.length > 0) {
      const weightsPath = weights.defaultPath();
      const weightMap = weights.loadFrom(weightsPath);
      const now = Date.now();
      for (const g of accepted) {
        const fileRel = `Agent Genes/${g.task_domain}.md`;
        weights.recordNewGene(weightMap, weights.geneKey({ file: fileRel, name: g.name }), now);
      }
      weights.saveTo(weightsPath, weightMap);
    }

    record.stage = 'done';
    record.accepted = accepted.length;
    record.skipped = skipped;
    record.accepted_genes = accepted.map(g => ({ domain: g.task_domain, body: g.gene_body }));
    writeEvolveLog(record);
    process.exit(0);
  } catch (err) {
    record.stage = 'error';
    record.error = err && err.message ? err.message : String(err);
    writeEvolveLog(record);
    process.stderr.write(`[gene-evolve] ${record.error}\n`);
    process.exit(0);
  } finally {
    releaseLock();
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  extractSlice,
  judgeTrigger,
  countMessages,
  sumAssistantDurationMs,
  isRealUserMessage,
  flattenTextOfMessage,
  matchAnyEn,
  matchAnyZh,
  matchCategory,
  foldHistory,
  jaccard,
  sanitizeDomain,
  sanitizeBody,
  parseGenesFile,
  topRelevantGenes,
  buildTaskPrompt,
  acquireLock,
  extractTrailingJsonObject,
};
