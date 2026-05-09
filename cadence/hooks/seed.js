// First-time seed copier. Triggered from gene-inject and gene-evolve at
// startup. Contract is intentionally minimal:
//
//   - If `<wikiDir>/Agent Genes/` already exists → no-op (user owns the wiki)
//   - Else → recursively cp `<pluginRoot>/seeds/Agent Genes/` into the wiki
//
// This means the plugin seeds exactly once: the first run after a fresh install.
// If the user later prunes a gene file, the plugin will not put it back. To
// re-seed, the user removes the whole `Agent Genes/` dir.

const fs = require('fs');
const path = require('path');

function copyTree(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  let copied = 0;
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);
    if (entry.isDirectory()) {
      copied += copyTree(s, d);
    } else if (entry.isFile()) {
      fs.copyFileSync(s, d);
      copied++;
    }
  }
  return copied;
}

/**
 * @param {object} opts
 * @param {string} opts.wikiDir     — `~/semaclaw/wiki` or override
 * @param {string} opts.pluginRoot  — directory containing `seeds/Agent Genes/`
 * @returns {{ ran: boolean, copied: number, reason?: string }}
 */
function ensureFirstTimeSeeds({ wikiDir, pluginRoot }) {
  const targetRoot = path.join(wikiDir, 'Agent Genes');
  if (fs.existsSync(targetRoot)) {
    return { ran: false, copied: 0, reason: 'already-exists' };
  }
  const seedsRoot = path.join(pluginRoot, 'seeds', 'Agent Genes');
  if (!fs.existsSync(seedsRoot)) {
    return { ran: false, copied: 0, reason: 'no-seeds-dir' };
  }
  const copied = copyTree(seedsRoot, targetRoot);
  return { ran: true, copied };
}

module.exports = { copyTree, ensureFirstTimeSeeds };
