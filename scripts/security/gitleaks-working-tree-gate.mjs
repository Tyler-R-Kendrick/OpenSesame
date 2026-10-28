#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { constants, lstatSync, openSync, closeSync, fstatSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const digest = (value) => createHash('sha256').update(value).digest('hex');
const isHash = (x) => typeof x === 'string' && /^[0-9a-f]{64}$/.test(x);

// No reviewed path may traverse a symlink, and the file must remain the same
// regular file while it is hashed. The caller also checks hashes before and
// after the scan. Unknown paths are never opened or exempted.
function fileHash(root, path) {
  if (typeof constants.O_NOFOLLOW !== 'number') throw new Error('Safe file opening is unavailable');
  if (typeof path !== 'string' || isAbsolute(path) || path.includes('\\') ||
      path.split('/').some((part) => !part || part === '.' || part === '..'))
    throw new Error('Invalid reviewed path');
  const parts = path.split('/');
  let cursor = resolve(root);
  for (const part of parts) {
    cursor = join(cursor, part);
    const stat = lstatSync(cursor);
    if (stat.isSymbolicLink()) throw new Error('Reviewed path contains a symlink');
  }
  const fd = openSync(cursor, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = fstatSync(fd);
    if (!before.isFile()) throw new Error('Reviewed path is not a regular file');
    const bytes = readFileSync(fd);
    const after = fstatSync(fd);
    const final = lstatSync(cursor);
    if (before.dev !== after.dev || before.ino !== after.ino ||
        before.size !== after.size || before.mtimeMs !== after.mtimeMs ||
        before.ctimeMs !== after.ctimeMs || final.dev !== after.dev || final.ino !== after.ino ||
        !final.isFile() || final.isSymbolicLink())
      throw new Error('Reviewed file changed while hashing');
    return digest(bytes);
  } finally { closeSync(fd); }
}

function loadManifest(file) {
  const contents = readFileSync(file, 'utf8');
  let entries;
  try { entries = JSON.parse(contents); } catch { throw new Error('Invalid review manifest'); }
  if (!Array.isArray(entries)) throw new Error('Invalid review manifest');
  const seen = new Set();
  for (const x of entries) {
    if (!x || typeof x !== 'object' || typeof x.path !== 'string' ||
        !/^[a-z0-9-]+$/.test(x.rule) || !Number.isSafeInteger(x.line) || x.line < 1 ||
        !isHash(x.fileSha256) || !isHash(x.matchSha256) ||
        typeof x.reason !== 'string' || !x.reason.trim()) throw new Error('Invalid reviewed finding');
    const key = JSON.stringify([x.path,x.rule,x.line,x.fileSha256,x.matchSha256]);
    if (seen.has(key)) throw new Error('Duplicate reviewed finding');
    seen.add(key);
  }
  return { entries, hash: digest(contents) };
}

export function prepare(root, manifest) {
  const paths = [...new Set(manifest.map((entry) => entry.path))];
  return Object.fromEntries(paths.map((path) => [path, fileHash(root, path)]));
}

export function classify(root, manifest, before, rows, status) {
  if (![0, 1].includes(status) || !Array.isArray(rows) ||
      (status === 0 && rows.length !== 0) || (status === 1 && rows.length === 0))
    throw new Error('Scanner failed or returned inconsistent results');
  if (!before || typeof before !== 'object' || Array.isArray(before)) throw new Error('Invalid pre-scan state');
  const after = prepare(root, manifest);
  if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error('Reviewed file changed during scan');
  const entries = new Map(manifest.map((x) => [JSON.stringify([x.path,x.rule,x.line,x.fileSha256,x.matchSha256]),x]));
  const used = new Set();
  const result = [];
  for (const finding of rows) {
    if (!finding || typeof finding !== 'object' || typeof finding.File !== 'string' ||
        typeof finding.RuleID !== 'string' || !/^[a-z0-9-]+$/.test(finding.RuleID) ||
        !Number.isSafeInteger(finding.StartLine) || finding.StartLine < 1 || typeof finding.Match !== 'string')
      throw new Error('Malformed scanner result');
    const key = JSON.stringify([finding.File, finding.RuleID, finding.StartLine, after[finding.File], digest(finding.Match)]);
    const reviewed = entries.has(key) && !used.has(key);
    if (reviewed) used.add(key);
    result.push({ pathSha256: digest(finding.File), ruleSha256: digest(finding.RuleID), line: finding.StartLine, reviewed });
  }
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [mode, root, manifestPath, statePath, rawPath, outputPath, statusText] = process.argv.slice(2);
  const { entries: manifest, hash: manifestHash } = loadManifest(manifestPath);
  if (mode === 'prepare' && process.argv.length === 6) {
    writeFileSync(statePath, JSON.stringify({manifestHash, files: prepare(root, manifest)}), { mode: 0o600 });
  } else if (mode === 'classify' && process.argv.length === 9) {
    const state = JSON.parse(readFileSync(statePath, 'utf8'));
    if (!state || state.manifestHash !== manifestHash) throw new Error('Review manifest changed during scan');
    let raw;
    try { raw = JSON.parse(readFileSync(rawPath, 'utf8')); }
    catch { throw new Error('Scanner report missing or malformed'); }
    const result = classify(root, manifest, state.files, raw, Number(statusText));
    writeFileSync(outputPath, JSON.stringify(result, null, 2) + '\n', { mode: 0o600 });
    const remaining = result.filter((row) => !row.reviewed).length;
    console.log(`Gitleaks: ${result.length} findings, ${result.length - remaining} individually reviewed, ${remaining} unreviewed`);
    if (remaining) process.exitCode = 1;
  } else throw new Error('Invalid invocation');
}
