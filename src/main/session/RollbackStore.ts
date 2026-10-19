import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as zlib from 'zlib';

/**
 * Undo snapshots live outside the session JSON.
 *
 * Every successful file edit stores the file's previous bytes so the turn can
 * be reverted. Those bytes used to sit inline as `beforeBase64`, which made a
 * long editing session grow without bound: one conversation here reached 82 MB,
 * and every save copied the whole thing to `.bak`.
 *
 * Snapshots are now written once, content-addressed and gzipped, under
 * `<sessions>/rollbacks/<sha256>.bin.gz`. The message keeps only `beforeRef`.
 * The undo route rehydrates the turn it is about to touch; nothing else needs
 * the bytes, and `clientMessages` already replaces rollback with a boolean.
 */
export interface RollbackSnapshot {
  version: 1;
  beforeExists: boolean;
  beforeBase64?: string;
  beforeRef?: string;
  afterSha256: string;
}

const REF_PATTERN = /^[a-f0-9]{64}$/;

export function isRollbackSnapshot(value: unknown): value is RollbackSnapshot {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return record.version === 1
    && typeof record.afterSha256 === 'string'
    && (typeof record.beforeBase64 === 'string' || typeof record.beforeRef === 'string');
}

export function rollbackPath(dir: string, ref: string): string {
  if (!REF_PATTERN.test(ref)) throw new Error('Invalid rollback reference');
  return path.join(dir, `${ref}.bin.gz`);
}

function writeSnapshot(dir: string, bytes: Buffer): string {
  const ref = createHash('sha256').update(bytes).digest('hex');
  const target = rollbackPath(dir, ref);
  if (fs.existsSync(target)) return ref;
  fs.mkdirSync(dir, { recursive: true });
  const payload = zlib.gzipSync(bytes, { level: 9 });
  const temp = `${target}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(temp, payload);
    // Identical bytes produce identical refs, so a concurrent writer racing us
    // to the same name is harmless: whichever rename lands first wins.
    try { fs.renameSync(temp, target); }
    catch { if (!fs.existsSync(target)) throw new Error('Rollback snapshot could not be stored'); }
  } finally {
    fs.rmSync(temp, { force: true });
  }
  return ref;
}

/**
 * Return a copy of `value` where every inline snapshot has been written to
 * `dir` and replaced with `beforeRef`. The input is left untouched: the live
 * session keeps its bytes for the undo path in this process.
 */
export function encodeRollbacks<T>(value: T, dir: string): T {
  return walkEncode(value, dir) as T;
}

function walkEncode(value: unknown, dir: string): unknown {
  if (Buffer.isBuffer(value) || value instanceof Date) return value;
  if (Array.isArray(value)) return value.map((item) => walkEncode(item, dir));
  if (!value || typeof value !== 'object') return value;
  if (isRollbackSnapshot(value)) {
    if (typeof value.beforeBase64 !== 'string') return value;
    const bytes = Buffer.from(value.beforeBase64, 'base64');
    if (bytes.length === 0) return value;
    const copy: RollbackSnapshot = { ...value, beforeRef: writeSnapshot(dir, bytes) };
    delete copy.beforeBase64;
    return copy;
  }
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value)) {
    out[key] = walkEncode((value as Record<string, unknown>)[key], dir);
  }
  return out;
}

/**
 * Restore `beforeBase64` for every snapshot that has a `beforeRef`, in place.
 * Call this on a freshly loaded session right before undo validation; a
 * missing or unreadable snapshot is left unresolved and `undoUnavailable`
 * reports the record as incomplete, which is the same outcome as an old
 * session that never had a snapshot.
 */
export function hydrateRollbacks<T>(value: T, dir: string): T {
  walkHydrate(value, dir);
  return value;
}

function walkHydrate(value: unknown, dir: string): void {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const item of value) walkHydrate(item, dir);
    return;
  }
  if (isRollbackSnapshot(value)) {
    if (!value.beforeBase64 && value.beforeRef) {
      try {
        const bytes = zlib.gunzipSync(fs.readFileSync(rollbackPath(dir, value.beforeRef)));
        value.beforeBase64 = bytes.toString('base64');
        return;
      } catch { /* leave the ref: undo reports this record as unavailable */ }
    }
    return;
  }
  for (const key of Object.keys(value)) {
    walkHydrate((value as Record<string, unknown>)[key], dir);
  }
}
