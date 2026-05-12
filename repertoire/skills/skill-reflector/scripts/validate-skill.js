#!/usr/bin/env node
// validate-skill.js — lint a SKILL.md against Anthropic Agent Skills conventions
// and Perplexity's routing-trigger rule. Pure Node, no dependencies.
//
// Usage:
//   node validate-skill.js <path-to-SKILL.md>
//   node validate-skill.js --stdin           # read content from stdin
//   node validate-skill.js <path> --json     # machine-readable output
//
// Exit codes:
//   0  all checks passed (warnings allowed)
//   1  one or more validation errors
//   2  bad invocation (missing file, bad args)

'use strict';

const fs = require('fs');
const path = require('path');

// ---- limits ----------------------------------------------------------------
const DESC_MAX_CHARS = 1024;   // Anthropic hard cap on frontmatter description
const DESC_MIN_CHARS = 40;     // below this a routing trigger has no substance
const BODY_MAX_LINES = 500;    // Anthropic recommends < 500 lines in SKILL.md
const BODY_MAX_WORDS = 5000;   // Anthropic suggested word cap
const BODY_MIN_WORDS = 50;     // anything less almost never justifies a skill

// ---- argv ------------------------------------------------------------------
const argv = process.argv.slice(2);
const wantJson = argv.includes('--json');
const useStdin = argv.includes('--stdin');
const filePath = argv.find(a => !a.startsWith('--'));

if (!useStdin && !filePath) {
  process.stderr.write(
    'Usage: validate-skill.js <path-to-SKILL.md> [--json]\n' +
    '       validate-skill.js --stdin [--json]\n'
  );
  process.exit(2);
}

// ---- read input ------------------------------------------------------------
let content;
try {
  content = useStdin
    ? fs.readFileSync(0, 'utf8')
    : fs.readFileSync(filePath, 'utf8');
} catch (e) {
  process.stderr.write(`Cannot read input: ${e.message}\n`);
  process.exit(2);
}

const errors = [];
const warnings = [];

// ---- filename --------------------------------------------------------------
if (filePath) {
  const base = path.basename(filePath);
  if (base !== 'SKILL.md') {
    errors.push(`Filename must be exactly "SKILL.md" (case-sensitive). Got: "${base}"`);
  }
}

// ---- frontmatter parser (minimal, single-line values only) -----------------
function parseFrontmatter(text) {
  const opener = text.match(/^---\r?\n/);
  if (!opener) {
    return { error: 'Missing opening "---" on first line' };
  }
  const after = text.slice(opener[0].length);
  const closeMatch = after.match(/\r?\n---\r?\n?/);
  if (!closeMatch) {
    return { error: 'Missing closing "---" delimiter' };
  }
  const fmText = after.slice(0, closeMatch.index);
  const body = after.slice(closeMatch.index + closeMatch[0].length);

  function stripQuotes(s) {
    if (
      (s.startsWith('"') && s.endsWith('"')) ||
      (s.startsWith("'") && s.endsWith("'"))
    ) {
      return s.slice(1, -1);
    }
    return s;
  }

  const fields = {};
  const lines = fmText.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const m = line.match(/^([A-Za-z][A-Za-z0-9_-]*)\s*:\s*(.*)$/);
    if (!m) {
      return { error: `Cannot parse frontmatter line: "${line}"` };
    }
    const key = m[1];
    let v = m[2].trim();

    // Block opener (e.g. `metadata:` with no value): consume indented children
    if (v === '') {
      const nested = {};
      while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1])) {
        i++;
        const child = lines[i];
        const cm = child.match(/^\s+([A-Za-z][A-Za-z0-9_-]*)\s*:\s*(.*)$/);
        if (!cm) {
          return { error: `Cannot parse nested frontmatter line under "${key}": "${child}"` };
        }
        nested[cm[1]] = stripQuotes(cm[2].trim());
      }
      fields[key] = nested;
      continue;
    }

    if (v === '|' || v === '>') {
      return { error: `Multi-line YAML block scalars not supported for field "${key}" — keep values on one line.` };
    }
    fields[key] = stripQuotes(v);
  }
  return { fields, body };
}

const parsed = parseFrontmatter(content);

if (parsed.error) {
  errors.push(`Frontmatter: ${parsed.error}`);
} else {
  const { fields, body } = parsed;

  // ---- required fields ----------------------------------------------------
  if (!fields.name) errors.push('Missing required frontmatter field: name');
  if (!fields.description) errors.push('Missing required frontmatter field: description');

  // ---- name ----------------------------------------------------------------
  if (fields.name) {
    if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(fields.name)) {
      errors.push(`name must be kebab-case (lowercase a-z, 0-9, hyphens only): "${fields.name}"`);
    }
    if (/claude|anthropic/i.test(fields.name)) {
      errors.push(`name must not contain "claude" or "anthropic" (reserved prefixes): "${fields.name}"`);
    }
    if (filePath) {
      const dirName = path.basename(path.dirname(path.resolve(filePath)));
      if (dirName !== fields.name) {
        warnings.push(`Skill dirname "${dirName}" does not match frontmatter name "${fields.name}". Convention: they should match.`);
      }
    }
  }

  // ---- description --------------------------------------------------------
  if (fields.description) {
    const d = fields.description;

    if (d.length > DESC_MAX_CHARS) {
      errors.push(`description too long: ${d.length} chars (Anthropic hard cap ${DESC_MAX_CHARS}).`);
    }
    if (d.length < DESC_MIN_CHARS) {
      warnings.push(`description very short: ${d.length} chars (target ≥ ${DESC_MIN_CHARS}). Routing triggers need substance.`);
    }
    if (/[<>]/.test(d)) {
      errors.push('description contains "<" or ">" — XML angle brackets forbidden in frontmatter (prompt-injection safety).');
    }
    if (!/^load when\b/i.test(d) && !/\buse when\b/i.test(d)) {
      warnings.push('description does not begin with "Load when…" or contain "use when…" — Anthropic/Perplexity recommend routing-trigger framing over feature-ad framing.');
    }
    if (!/["'“”‘’]/.test(d)) {
      warnings.push('description contains no quoted phrases — embed verbatim user trigger phrases for better routing accuracy.');
    }
  }

  // ---- body ---------------------------------------------------------------
  const bodyTrim = body.trim();
  const lineCount = bodyTrim ? bodyTrim.split(/\r?\n/).length : 0;
  const wordCount = bodyTrim ? bodyTrim.split(/\s+/).filter(Boolean).length : 0;

  if (lineCount > BODY_MAX_LINES) {
    warnings.push(`Body is ${lineCount} lines (target < ${BODY_MAX_LINES}). Move overflow to references/ via progressive disclosure.`);
  }
  if (wordCount > BODY_MAX_WORDS) {
    warnings.push(`Body is ${wordCount} words (target < ${BODY_MAX_WORDS}). Same advice — split via references/.`);
  }
  if (wordCount < BODY_MIN_WORDS) {
    warnings.push(`Body is only ${wordCount} words — likely too thin to be a real skill. Re-check the "every skill is a tax" test (step 0a).`);
  }
}

// ---- report ----------------------------------------------------------------
const target = filePath || '<stdin>';

if (wantJson) {
  process.stdout.write(JSON.stringify({
    target,
    ok: errors.length === 0,
    errors,
    warnings,
  }, null, 2) + '\n');
} else {
  process.stdout.write(`SKILL.md validator — ${target}\n\n`);
  if (errors.length) {
    process.stdout.write(`ERRORS (${errors.length}):\n`);
    for (const e of errors) process.stdout.write(`  - ${e}\n`);
    process.stdout.write('\n');
  }
  if (warnings.length) {
    process.stdout.write(`WARNINGS (${warnings.length}):\n`);
    for (const w of warnings) process.stdout.write(`  - ${w}\n`);
    process.stdout.write('\n');
  }
  if (!errors.length && !warnings.length) {
    process.stdout.write('All checks passed.\n');
  } else if (!errors.length) {
    process.stdout.write('Passed (with warnings).\n');
  } else {
    process.stdout.write('Failed. Fix errors and re-run.\n');
  }
}

process.exit(errors.length ? 1 : 0);
