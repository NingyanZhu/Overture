// Gene weight sidecar. Lives at ~/.semaclaw/gene-weights.json keyed by
// "<rel-path>::<gene-name>" and stores { base, hits, last_hit }. Effective
// weight at time `now` is base * 0.5 ^ ((now - last_hit) / HALF_LIFE_MS),
// floored at MIN_WEIGHT. Genes never seen default to 1.0.
//
// Pure-data helpers; the hooks own all fs I/O.

const fs = require('fs');
const path = require('path');
const os = require('os');

const HALF_LIFE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const MIN_WEIGHT = 0.3;
const MAX_WEIGHT = 1.5;
const HIT_BUMP = 0.1;

function defaultPath() {
  const root = process.env.SEMACLAW_ROOT || path.join(os.homedir(), '.semaclaw');
  return path.join(root, 'gene-weights.json');
}

function loadFrom(filePath) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function saveTo(filePath, map) {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const tmp = filePath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(map), 'utf8');
    fs.renameSync(tmp, filePath);
    return true;
  } catch {
    return false;
  }
}

function geneKey(gene) {
  // gene.file is like "Agent Genes/Research/Search.md"; gene.name is the ## heading
  return `${gene.file}::${gene.name}`;
}

function effectiveWeight(entry, now) {
  if (!entry || typeof entry !== 'object') return 1.0;
  const base = typeof entry.base === 'number' ? entry.base : 1.0;
  const lastHit = entry.last_hit ? Date.parse(entry.last_hit) : NaN;
  if (!Number.isFinite(lastHit)) return Math.max(MIN_WEIGHT, Math.min(MAX_WEIGHT, base));
  const elapsed = Math.max(0, now - lastHit);
  const decay = Math.pow(0.5, elapsed / HALF_LIFE_MS);
  return Math.max(MIN_WEIGHT, Math.min(MAX_WEIGHT, base * decay));
}

function bumpHit(map, key, now) {
  const prev = map[key] || { base: 1.0, hits: 0 };
  const base = Math.min(MAX_WEIGHT, (typeof prev.base === 'number' ? prev.base : 1.0) + HIT_BUMP);
  map[key] = {
    base,
    hits: (prev.hits || 0) + 1,
    last_hit: new Date(now).toISOString(),
  };
  return map;
}

function recordNewGene(map, key, now) {
  // Called from gene-evolve when a freshly distilled gene is appended to wiki.
  // Start at base 1.0 with last_hit = now so it competes fairly with veterans.
  map[key] = { base: 1.0, hits: 0, last_hit: new Date(now).toISOString() };
  return map;
}

module.exports = {
  HALF_LIFE_MS, MIN_WEIGHT, MAX_WEIGHT, HIT_BUMP,
  defaultPath,
  loadFrom,
  saveTo,
  geneKey,
  effectiveWeight,
  bumpHit,
  recordNewGene,
};
