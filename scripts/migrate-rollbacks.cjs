#!/usr/bin/env node
/**
 * Rewrite existing session files so inline undo snapshots move to
 * <sessions>/rollbacks/<sha256>.bin.gz.
 *
 * Safe to re-run: files without inline snapshots are skipped, and a session is
 * only replaced when it has not changed since it was read (the app may be
 * writing concurrently). The stale .bak is removed afterwards because it still
 * holds the old 80 MB shape.
 */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const dir = path.join(root, 'workspace', '.iexa-sessions');
const rollbacks = path.join(dir, 'rollbacks');
const { encodeRollbacks } = require(path.join(root, 'dist', 'main', 'session', 'RollbackStore.js'));

function mb(bytes) { return (bytes / 1048576).toFixed(1) + ' MB'; }

let before = 0;
let after = 0;
let migrated = 0;

for (const name of fs.readdirSync(dir)) {
  if (!name.endsWith('.json')) continue;
  const file = path.join(dir, name);
  const stat = fs.statSync(file);
  const raw = fs.readFileSync(file, 'utf8');
  before += stat.size;
  if (!raw.includes('"beforeBase64"')) {
    after += stat.size;
    continue;
  }
  let data;
  try { data = JSON.parse(raw); }
  catch { console.log(`skip (invalid JSON)  ${name}`); after += stat.size; continue; }

  const encoded = encodeRollbacks(data, rollbacks);
  const out = JSON.stringify(encoded);

  const now = fs.statSync(file);
  if (now.size !== stat.size || now.mtimeMs !== stat.mtimeMs) {
    console.log(`skip (changed while reading)  ${name}`);
    after += stat.size;
    continue;
  }

  const tmp = `${file}.${process.pid}.migrate.tmp`;
  fs.writeFileSync(tmp, out);
  fs.renameSync(tmp, file);
  fs.rmSync(`${file}.bak`, { force: true });
  after += Buffer.byteLength(out);

  migrated++;
  console.log(`${name}  ${mb(stat.size)} -> ${mb(Buffer.byteLength(out))}`);
}

const stored = fs.existsSync(rollbacks)
  ? fs.readdirSync(rollbacks).reduce((sum, f) => sum + fs.statSync(path.join(rollbacks, f)).size, 0)
  : 0;

console.log(`\nmigrated sessions: ${migrated}`);
console.log(`session JSON: ${mb(before)} -> ${mb(after)}`);
console.log(`rollback store: ${mb(stored)} (${fs.existsSync(rollbacks) ? fs.readdirSync(rollbacks).length : 0} files)`);
console.log(`on disk total: ${mb(after + stored)}`);
