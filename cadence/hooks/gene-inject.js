#!/usr/bin/env node
// UserPromptSubmit hook (blocking, type=command):
//   1. Tokenize user prompt → keyword set
//   2. Walk wiki/Agent Genes/**/*.md, parse each `## name` block + `intent: [...]` line
//   3. Score by |prompt_keywords ∩ gene_intent| / |gene_intent|
//   4. Emit JSON {"additionalContext": "<agent-genes ...>...</agent-genes>"} for top-N
//
// Output flows to user message via sema-core CommandExecutor → SemaEngine; see
// sema-code-core src/hooks + src/engine/SemaEngine.ts:283.

const fs = require('fs');
const path = require('path');
const os = require('os');
const weights = require('./weights');
const seed = require('./seed');

const PLUGIN_ROOT = path.dirname(path.dirname(__filename));

function loadConfig() {
  try {
    const raw = fs.readFileSync(path.join(PLUGIN_ROOT, 'gene-categories.json'), 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
const CONFIG = loadConfig();
const INJECT = (CONFIG && CONFIG.inject) || {};
const MAX_GENES = INJECT.max_genes ?? 8;
const MIN_SCORE = INJECT.min_score ?? 0.05;
const SKIP_IF_WORDS_LT = INJECT.skip_if_prompt_words_lt ?? 10;

const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'if', 'then', 'so', 'because',
  'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did', 'doing',
  'i', 'you', 'he', 'she', 'it', 'we', 'they', 'me', 'him', 'her', 'us', 'them',
  'my', 'your', 'his', 'its', 'our', 'their',
  'this', 'that', 'these', 'those',
  'to', 'of', 'in', 'on', 'at', 'by', 'for', 'with', 'from', 'as', 'about',
  'can', 'could', 'would', 'should', 'will', 'shall', 'may', 'might', 'must',
  'not', 'no', 'yes',
  'please', 'help', 'just', 'really', 'very', 'much', 'some', 'any', 'all',
  'how', 'what', 'why', 'when', 'where', 'who', 'which',
]);

function getWikiDir() {
  if (process.env.WIKI_DIR) return process.env.WIKI_DIR;
  return path.join(os.homedir(), 'semaclaw', 'wiki');
}

function readStdin() {
  return new Promise(resolve => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
    if (process.stdin.isTTY) resolve('');
  });
}

function tokenize(text) {
  if (!text || typeof text !== 'string') return new Set();
  const lower = text.toLowerCase();
  const out = new Set();
  // English / digits
  const enMatches = lower.match(/[a-z][a-z0-9_-]{1,}/g) || [];
  for (const w of enMatches) {
    if (w.length < 3) continue;
    if (STOPWORDS.has(w)) continue;
    out.add(w);
  }
  // Chinese: take 2-char and 3-char windows; lossy but cheap
  const zh = lower.replace(/[^一-鿿]+/g, ' ').trim();
  if (zh) {
    for (const seg of zh.split(/\s+/)) {
      for (let i = 0; i < seg.length; i++) {
        if (i + 2 <= seg.length) out.add(seg.slice(i, i + 2));
        if (i + 3 <= seg.length) out.add(seg.slice(i, i + 3));
      }
    }
  }
  return out;
}

function* walkMd(dir) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
  catch { return; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) yield* walkMd(full);
    else if (e.isFile() && e.name.endsWith('.md')) yield full;
  }
}

function parseGenes(filePath, wikiRoot) {
  let content;
  try { content = fs.readFileSync(filePath, 'utf8'); }
  catch { return []; }

  // Strip frontmatter
  let body = content;
  if (body.startsWith('---')) {
    const end = body.indexOf('\n---', 3);
    if (end >= 0) body = body.slice(end + 4);
  }

  const rel = path.relative(wikiRoot, filePath); // e.g. "Agent Genes/Research/Search.md"
  const blocks = body.split(/^## /m).slice(1); // first chunk before first ## is preamble
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
    if (!text) continue;
    if (intent.length === 0) continue;
    genes.push({ file: rel, name, intent, text });
  }
  return genes;
}

function scoreGene(promptKeywords, gene) {
  if (gene.intent.length === 0) return 0;
  let hits = 0;
  for (const k of gene.intent) {
    if (promptKeywords.has(k)) { hits++; continue; }
    // also allow substring match on multi-word/Chinese keywords
    for (const p of promptKeywords) {
      if (p.length >= 2 && (k.includes(p) || p.includes(k))) { hits++; break; }
    }
  }
  return hits / gene.intent.length;
}

function deriveCategoryAttr(genes) {
  const cats = new Set();
  for (const g of genes) {
    // file like "Agent Genes/Research/Search.md" → category "Research/Search"
    const stripped = g.file.replace(/^Agent Genes[\\/]/, '').replace(/\.md$/, '');
    cats.add(stripped);
  }
  return Array.from(cats).join(' ');
}

function emit(injection) {
  // sema-core HookOutput shape: additionalContext string is appended to user message.
  process.stdout.write(JSON.stringify({ additionalContext: injection }));
}

function rankGenes(promptKw, allGenes, weightMap, now) {
  const scored = [];
  for (const g of allGenes) {
    const raw = scoreGene(promptKw, g);
    if (raw < MIN_SCORE) continue;
    const w = weights.effectiveWeight(weightMap[weights.geneKey(g)], now);
    scored.push({ g, raw, weight: w, score: raw * w });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, MAX_GENES);
}

async function main() {
  // 先把 stdin 读完再做任何早退判断，避免父进程（sema-core CommandExecutor）
  // 仍在 write payload 时我们已退出，触发未捕获的 EPIPE 把 daemon 干掉。
  let stdin = '';
  try { stdin = await readStdin(); } catch {}

  if (process.env.SEMACLAW_INTERNAL_AGENT === '1') return 0;

  let payload;
  try {
    payload = stdin ? JSON.parse(stdin) : {};
  } catch { return 0; }

  const prompt = typeof payload.prompt === 'string' ? payload.prompt : '';
  if (!prompt.trim()) return 0;

  const wordCount = (prompt.trim().split(/\s+/).filter(Boolean).length)
    + (prompt.match(/[一-鿿]/g) || []).length / 2;
  if (wordCount < SKIP_IF_WORDS_LT) return 0;

  const wikiDir = getWikiDir();
  // First-time seed: only when `Agent Genes/` doesn't exist yet
  seed.ensureFirstTimeSeeds({ wikiDir, pluginRoot: PLUGIN_ROOT });
  const genesDir = path.join(wikiDir, 'Agent Genes');
  if (!fs.existsSync(genesDir)) return 0;

  const promptKw = tokenize(prompt);
  if (promptKw.size === 0) return 0;

  const all = [];
  for (const f of walkMd(genesDir)) {
    all.push(...parseGenes(f, wikiDir));
  }
  if (all.length === 0) return 0;

  const weightsPath = weights.defaultPath();
  const weightMap = weights.loadFrom(weightsPath);
  const now = Date.now();

  const ranked = rankGenes(promptKw, all, weightMap, now);
  if (ranked.length === 0) return 0;

  const picked = ranked.map(x => x.g);
  // Group genes by category and render as a single <system-reminder> with
  // `##Cat/Sub` sections. The LLM consumes this as a normal system reminder —
  // no plugin-internal terminology ("agent-genes" etc.) leaks through.
  const byCat = new Map();
  for (const g of picked) {
    const cat = g.file.replace(/^Agent Genes[\\/]/, '').replace(/\.md$/, '');
    if (!byCat.has(cat)) byCat.set(cat, []);
    byCat.get(cat).push(g);
  }
  const lines = ['<system-reminder>'];
  for (const [cat, genes] of byCat) {
    lines.push(`##${cat}`);
    for (const g of genes) {
      lines.push(g.text.replace(/\s+/g, ' ').trim());
    }
  }
  lines.push('</system-reminder>');
  emit(lines.join('\n'));

  // Bump hits on all picked genes; persist sidecar.
  for (const g of picked) {
    weights.bumpHit(weightMap, weights.geneKey(g), now);
  }
  weights.saveTo(weightsPath, weightMap);
  return 0;
}

if (require.main === module) {
  main()
    .then(code => process.exit(code))
    .catch(err => {
      process.stderr.write(`[gene-inject] ${err && err.message ? err.message : err}\n`);
      process.exit(0);
    });
}

module.exports = {
  tokenize,
  parseGenes,
  scoreGene,
  rankGenes,
  deriveCategoryAttr,
  STOPWORDS,
};
