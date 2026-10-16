#!/usr/bin/env node
// signet-gate: standing rule #9 — re-scan before release.
// Scans the whole tree for old-network traces in ANY file type and ANY
// encoding: the old-network word family, the old bech32 prefix, the old
// CAIP-2 chain id, the old genesis hash, and both hex forms byte-reversed
// (the daemon's internal order), so nothing hides behind a file extension
// or a reversed hex string again.
//
// Every pattern is built at runtime from split fragments on purpose: the
// gate scans its OWN source with zero exclusions, and its own constants
// and labels must not be detectable markers. Do not "simplify" the
// fragments back into literals — that would make the gate flag itself.
//
// Exit 0 = clean; exit 1 = markers found (listed). Safe to run any time.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SKIP = new Set(['.git', 'node_modules', '.vercel', '.next', '.svelte-kit']);

// hex constants split across quotes (see header: self-scan safe)
const GEN_OLD = ['0f9188f13cb7b2c7', '1f2a335e3a4fc328', '7fb3902c21c3221b', '7b049c4fb9e57855'].join('');
const CAIP_OLD = ['0f9188f13cb7b2c7', '1f2a335e3a4fc328'].join('');
const rev = (hex) => Buffer.from(hex, 'hex').reverse().toString('hex');

const PATTERNS = [
  ['old-network word', new RegExp('re' + 'g[-_ ]?' + 'tes' + 't', 'gi')],
  ['old bech32 prefix', new RegExp('bc' + 'rt', 'gi')],
  ['old genesis', new RegExp(GEN_OLD, 'gi')],
  ['old genesis (reversed)', new RegExp(rev(GEN_OLD), 'gi')],
  ['old CAIP-2 id', new RegExp(CAIP_OLD, 'gi')],
  ['old CAIP-2 id (reversed)', new RegExp(rev(CAIP_OLD), 'gi')],
  ['old daemon host', new RegExp('rpc-' + 'reg' + 'tes' + 't', 'gi')],
  ['old chain id', new RegExp('tachi[-:]?' + 'reg[-_ ]?' + 'tes' + 't[-_]?\\d', 'gi')],
];

function* walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue;
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(p);
    else yield p;
  }
}

let files = 0;
let dirty = 0;
for (const file of walk(ROOT)) {
  let data;
  try {
    data = fs.readFileSync(file, 'utf8');
  } catch {
    continue;
  }
  files++;
  for (const [name, pat] of PATTERNS) {
    pat.lastIndex = 0;
    const hits = data.match(pat);
    if (hits) {
      dirty++;
      console.log(`MARKER [${name}] x${hits.length}: ${path.relative(ROOT, file)}`);
    }
  }
}

console.log(`signet-gate: ${files} files scanned`);
if (dirty) {
  console.log(`signet-gate: FAIL — ${dirty} file(s) with old-network markers`);
  process.exit(1);
}
console.log('signet-gate: PASS — zero old-network markers (words + hex ids + reversed forms, all file types)');
