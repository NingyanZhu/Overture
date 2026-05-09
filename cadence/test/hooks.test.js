// Run with: node --test cadence/test/
//
// Loads the hook scripts as plain modules (require.main !== module guards
// auto-execution). Tests pure helpers — no fs, no spawn, no stdin.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const inject = require('../hooks/gene-inject');
const evolve = require('../hooks/gene-evolve');
const weights = require('../hooks/weights');
const seed = require('../hooks/seed');

// ───────── weights ─────────

test('weights.effectiveWeight: missing entry → 1.0', () => {
  assert.equal(weights.effectiveWeight(undefined, Date.now()), 1.0);
  assert.equal(weights.effectiveWeight(null, Date.now()), 1.0);
});

test('weights.effectiveWeight: fresh hit returns base (clamped)', () => {
  const now = Date.now();
  const e = { base: 1.2, last_hit: new Date(now).toISOString() };
  const w = weights.effectiveWeight(e, now);
  assert.ok(Math.abs(w - 1.2) < 1e-6, `got ${w}`);
});

test('weights.effectiveWeight: 30 days old halves the weight', () => {
  const now = Date.now();
  const past = now - weights.HALF_LIFE_MS;
  const e = { base: 1.0, last_hit: new Date(past).toISOString() };
  const w = weights.effectiveWeight(e, now);
  assert.ok(Math.abs(w - 0.5) < 1e-6, `got ${w}`);
});

test('weights.effectiveWeight: never falls below MIN_WEIGHT', () => {
  const now = Date.now();
  const past = now - weights.HALF_LIFE_MS * 100; // very old
  const e = { base: 1.0, last_hit: new Date(past).toISOString() };
  assert.equal(weights.effectiveWeight(e, now), weights.MIN_WEIGHT);
});

test('weights.bumpHit: increments hits and base, caps at MAX_WEIGHT', () => {
  const map = {};
  const now = Date.now();
  weights.bumpHit(map, 'k', now);
  assert.equal(map.k.hits, 1);
  assert.ok(map.k.base > 1.0);
  // bump many times → cap at MAX_WEIGHT
  for (let i = 0; i < 50; i++) weights.bumpHit(map, 'k', now);
  assert.ok(map.k.base <= weights.MAX_WEIGHT + 1e-9, `got ${map.k.base}`);
});

test('weights.geneKey: derives "<file>::<name>" key', () => {
  assert.equal(weights.geneKey({ file: 'Agent Genes/Research/Search.md', name: 'foo' }),
    'Agent Genes/Research/Search.md::foo');
});

test('weights.loadFrom / saveTo: roundtrip via tmpfile', () => {
  const tmp = path.join(os.tmpdir(), `cadence-weights-${Date.now()}.json`);
  const map = { 'k::a': { base: 1.1, hits: 2, last_hit: new Date().toISOString() } };
  weights.saveTo(tmp, map);
  const loaded = weights.loadFrom(tmp);
  assert.deepEqual(loaded, map);
  fs.unlinkSync(tmp);
});

test('weights.loadFrom: missing file → empty object (no throw)', () => {
  const result = weights.loadFrom('/nonexistent/path/' + Date.now());
  assert.deepEqual(result, {});
});

// ───────── seed ─────────

test('seed.ensureFirstTimeSeeds: cps when target dir is missing', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cadence-seed-'));
  const pluginRoot = path.join(__dirname, '..');
  const r = seed.ensureFirstTimeSeeds({ wikiDir: tmp, pluginRoot });
  assert.equal(r.ran, true);
  assert.ok(r.copied >= 6, `copied ${r.copied}`);
  assert.ok(fs.existsSync(path.join(tmp, 'Agent Genes', 'Research', 'Search.md')));
  assert.ok(fs.existsSync(path.join(tmp, 'Agent Genes', 'Coding', 'Implementation.md')));
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('seed.ensureFirstTimeSeeds: no-op when target dir already exists', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cadence-seed-'));
  fs.mkdirSync(path.join(tmp, 'Agent Genes'), { recursive: true });
  // user has only one custom file, no seed structure
  fs.writeFileSync(path.join(tmp, 'Agent Genes', 'CUSTOM.md'), '# user', 'utf8');
  const before = fs.readdirSync(path.join(tmp, 'Agent Genes')).sort();
  const r = seed.ensureFirstTimeSeeds({ wikiDir: tmp, pluginRoot: path.join(__dirname, '..') });
  assert.equal(r.ran, false);
  assert.equal(r.reason, 'already-exists');
  // Nothing added — user wiki untouched
  const after = fs.readdirSync(path.join(tmp, 'Agent Genes')).sort();
  assert.deepEqual(after, before);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('seed.ensureFirstTimeSeeds: no-op when plugin has no seeds dir', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cadence-seed-'));
  const fakePlugin = fs.mkdtempSync(path.join(os.tmpdir(), 'cadence-plugin-'));
  const r = seed.ensureFirstTimeSeeds({ wikiDir: tmp, pluginRoot: fakePlugin });
  assert.equal(r.ran, false);
  assert.equal(r.reason, 'no-seeds-dir');
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.rmSync(fakePlugin, { recursive: true, force: true });
});

// ───────── gene-inject ─────────

test('inject.tokenize: english + drops stopwords + length', () => {
  const kw = inject.tokenize('Please help me debug the rate-limit error in search API');
  assert.ok(kw.has('debug'));
  assert.ok(kw.has('rate-limit') || kw.has('rate'));
  assert.ok(kw.has('search'));
  assert.ok(kw.has('api'));
  assert.ok(!kw.has('the'));
  assert.ok(!kw.has('me'));
});

test('inject.tokenize: chinese 2/3-grams', () => {
  const kw = inject.tokenize('搜索 接口 限流');
  // 2-grams should appear
  assert.ok(kw.has('搜索') || kw.has('接口') || kw.has('限流'));
});

test('inject.scoreGene: full intent overlap → 1.0', () => {
  const gene = { intent: ['search', 'rate-limit', 'retry'] };
  const kw = new Set(['search', 'rate-limit', 'retry', 'unrelated']);
  assert.equal(inject.scoreGene(kw, gene), 1.0);
});

test('inject.scoreGene: partial overlap', () => {
  const gene = { intent: ['search', 'rate-limit', 'retry', 'overload'] };
  const kw = new Set(['search', 'foo']);
  assert.ok(Math.abs(inject.scoreGene(kw, gene) - 0.25) < 1e-9);
});

test('inject.scoreGene: empty intent → 0', () => {
  assert.equal(inject.scoreGene(new Set(['x']), { intent: [] }), 0);
});

test('inject.parseGenes: roundtrip seed file', () => {
  const seedPath = path.join(__dirname, '..', 'seeds', 'Agent Genes', 'Research', 'Search.md');
  const wikiRoot = path.join(__dirname, '..', 'seeds');
  const genes = inject.parseGenes(seedPath, wikiRoot);
  assert.ok(genes.length >= 3, `parsed ${genes.length} genes`);
  const rate = genes.find(g => g.name === 'search-rate-limit');
  assert.ok(rate, 'search-rate-limit gene should exist');
  assert.ok(rate.intent.includes('rate-limit'));
  assert.ok(rate.text.startsWith('AVOID'));
  assert.equal(rate.file, 'Agent Genes/Research/Search.md');
});

test('inject.deriveCategoryAttr: from gene file paths', () => {
  const attr = inject.deriveCategoryAttr([
    { file: 'Agent Genes/Research/Search.md' },
    { file: 'Agent Genes/General/TaskBreakdown.md' },
    { file: 'Agent Genes/Research/Search.md' }, // dedup
  ]);
  const parts = attr.split(' ').sort();
  assert.deepEqual(parts, ['General/TaskBreakdown', 'Research/Search']);
});

test('inject.rankGenes: weight scales score and reorders', () => {
  const genes = [
    { file: 'f.md', name: 'a', intent: ['x', 'y'], text: 'A' },
    { file: 'f.md', name: 'b', intent: ['x', 'y'], text: 'B' },
  ];
  const kw = new Set(['x']);
  const now = Date.now();
  // raw scores equal (0.5 each) — weight tips the order
  const map = {
    'f.md::a': { base: 1.5, last_hit: new Date(now).toISOString() },
    'f.md::b': { base: 1.0, last_hit: new Date(now - weights.HALF_LIFE_MS).toISOString() }, // decayed to 0.5
  };
  const ranked = inject.rankGenes(kw, genes, map, now);
  assert.equal(ranked.length, 2);
  assert.equal(ranked[0].g.name, 'a', 'higher weight should win');
});

// ───────── gene-evolve ─────────

test('evolve.isRealUserMessage: distinguishes real user vs tool_result wrapper', () => {
  assert.ok(evolve.isRealUserMessage({ type: 'user', toolUseResult: undefined }));
  assert.ok(!evolve.isRealUserMessage({ type: 'user', toolUseResult: { stdout: 'x' } }));
  assert.ok(!evolve.isRealUserMessage({ type: 'assistant' }));
});

test('evolve.extractSlice: takes from latest real user msg to end', () => {
  const hist = [
    { type: 'user', toolUseResult: undefined, message: { content: 'first' } },
    { type: 'assistant', message: { content: 'a' } },
    { type: 'user', toolUseResult: undefined, message: { content: 'second' } },
    { type: 'assistant', message: { content: 'b' } },
    { type: 'user', toolUseResult: { stdout: 'tool' } }, // tool_result wrapper
  ];
  const slice = evolve.extractSlice(hist);
  assert.equal(slice.length, 3);
  assert.equal(slice[0].message.content, 'second');
});

test('evolve.extractSlice: empty / no real user → empty', () => {
  assert.deepEqual(evolve.extractSlice([]), []);
  assert.deepEqual(evolve.extractSlice([{ type: 'assistant' }]), []);
});

test('evolve.countTurns: counts message boundaries', () => {
  const slice = [{}, {}, {}, {}];
  assert.equal(evolve.countTurns(slice), 4);
});

test('evolve.sumAssistantDurationMs: sums only assistant durationMs', () => {
  const slice = [
    { type: 'user', durationMs: 999 },
    { type: 'assistant', durationMs: 100 },
    { type: 'assistant', message: { durationMs: 200 } },
    { type: 'assistant' },
  ];
  assert.equal(evolve.sumAssistantDurationMs(slice), 300);
});

test('evolve.matchAnyEn: word-boundary match, case insensitive', () => {
  const hits = evolve.matchAnyEn('We Failed and got rate-limited', ['failed', 'rate-limited', 'success']);
  assert.ok(hits.has('failed'));
  assert.ok(hits.has('rate-limited'));
  assert.ok(!hits.has('success'));
});

test('evolve.matchAnyEn: multi-word phrases (with space) use includes', () => {
  const hits = evolve.matchAnyEn('hit the rate limit and timed out', ['rate limit', 'timed out', 'success']);
  assert.ok(hits.has('rate limit'));
  assert.ok(hits.has('timed out'));
});

test('evolve.matchAnyZh: substring match', () => {
  const hits = evolve.matchAnyZh('请求又超时了', ['超时', '失败']);
  assert.ok(hits.has('超时'));
  assert.ok(!hits.has('失败'));
});

test('evolve.judgeTrigger: A only → not fired', () => {
  const slice = Array.from({ length: 20 }, () => ({ type: 'assistant', message: { content: 'ok' } }));
  // include one real user msg at the start so extractSlice not invoked here, but our trigger reads the slice as given
  const r = evolve.judgeTrigger(slice);
  assert.ok(r.aHit);
  assert.ok(!r.bHit);
  assert.ok(!r.cHit);
  assert.ok(!r.fire);
});

test('evolve.judgeTrigger: A + B → fires', () => {
  const slice = Array.from({ length: 20 }, () => ({ type: 'assistant', durationMs: 10000 }));
  const r = evolve.judgeTrigger(slice);
  assert.ok(r.aHit);
  assert.ok(r.bHit);
  assert.ok(r.fire);
});

test('evolve.judgeTrigger: C1 (user dissatisfaction) alone is not enough; needs second hit', () => {
  const slice = [
    { type: 'user', toolUseResult: undefined, message: { content: '你蠢死了 浪费时间' } },
  ];
  const r = evolve.judgeTrigger(slice);
  assert.ok(r.cHit);
  assert.ok(!r.aHit);
  assert.ok(!r.bHit);
  assert.ok(!r.fire);
});

test('evolve.judgeTrigger: B + C fires', () => {
  const slice = Array.from({ length: 5 }, () => ({ type: 'assistant', durationMs: 50000 }));
  slice.unshift({ type: 'user', toolUseResult: undefined, message: { content: '怎么又失败了，错误又超时' } });
  const r = evolve.judgeTrigger(slice);
  assert.ok(r.bHit);
  assert.ok(r.cHit);
  assert.ok(r.fire);
});

test('evolve.foldHistory: stays under HISTORY_MAX_CHARS budget', () => {
  const slice = [];
  for (let i = 0; i < 50; i++) {
    slice.push({ type: 'user', toolUseResult: undefined, message: { content: 'X'.repeat(2000) } });
    slice.push({
      type: 'assistant',
      message: {
        content: [
          { type: 'text', text: 'Y'.repeat(2000) },
          { type: 'tool_use', name: 'Bash', input: { command: 'Z'.repeat(2000) } },
        ],
      },
    });
  }
  const folded = evolve.foldHistory(slice);
  assert.ok(folded.length <= 4500, `folded length ${folded.length}`); // small slack for the truncation marker
});

test('evolve.foldHistory: surfaces tool_result errors', () => {
  // Real sema-core history sets toolUseResult on the wrapper so isRealUserMessage()
  // returns false; foldHistory then routes into the tool_result rendering branch.
  const slice = [
    {
      type: 'user',
      toolUseResult: { stdout: '' },
      message: {
        content: [
          { type: 'tool_result', is_error: true, content: 'rate_limited 429' },
        ],
      },
    },
  ];
  const folded = evolve.foldHistory(slice);
  assert.ok(folded.includes('ERROR'), `expected ERROR in: ${folded}`);
});

test('evolve.jaccard: identical sets → 1, disjoint → 0', () => {
  assert.equal(evolve.jaccard(['a', 'b'], ['a', 'b']), 1);
  assert.equal(evolve.jaccard(['a'], ['b']), 0);
  assert.equal(evolve.jaccard([], []), 1);
  assert.ok(Math.abs(evolve.jaccard(['a', 'b', 'c'], ['b', 'c', 'd']) - 0.5) < 1e-9);
});

test('evolve.sanitizeDomain: depth ≤ 2, allowed charset', () => {
  assert.equal(evolve.sanitizeDomain('Research/Search'), 'Research/Search');
  assert.equal(evolve.sanitizeDomain('General'), 'General');
  assert.equal(evolve.sanitizeDomain('A/B/C'), null, 'depth > 2 should reject');
  assert.equal(evolve.sanitizeDomain('foo$/bar'), null, 'invalid chars should reject');
  assert.equal(evolve.sanitizeDomain(''), null);
  assert.equal(evolve.sanitizeDomain(123), null);
});

test('evolve.sanitizeBody: AVOID/DO prefix, ≤ 35 words, single line', () => {
  assert.equal(evolve.sanitizeBody('AVOID: doing X when Y'), 'AVOID: doing X when Y');
  assert.equal(evolve.sanitizeBody('DO: thing\nwith newline'), 'DO: thing with newline');
  assert.equal(evolve.sanitizeBody('something without prefix'), null);
  const longBody = 'AVOID: ' + Array(40).fill('word').join(' ');
  assert.equal(evolve.sanitizeBody(longBody), null);
});
