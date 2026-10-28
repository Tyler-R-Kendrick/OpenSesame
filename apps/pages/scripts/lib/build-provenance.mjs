import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

function updateLengthPrefixed(hash, bytes, width) {
  const length = Buffer.alloc(width);
  if (width === 4) length.writeUInt32BE(bytes.length);
  else length.writeBigUInt64BE(BigInt(bytes.length));
  hash.update(length).update(bytes);
}

function distributionFiles(root) {
  const files = [];
  function walk(directory) {
    for (const entry of fs.readdirSync(directory)) {
      const file = path.join(directory, entry);
      const stat = fs.lstatSync(file);
      if (stat.isSymbolicLink())
        throw new Error(`Distribution contains a symlink: ${file}`);
      if (stat.isDirectory()) walk(file);
      else if (stat.isFile()) files.push(file);
      else
        throw new Error(`Distribution contains an unsupported entry: ${file}`);
    }
  }
  const stat = fs.lstatSync(root);
  if (stat.isSymbolicLink())
    throw new Error(`Distribution root is a symlink: ${root}`);
  if (!stat.isDirectory())
    throw new Error(`Distribution is not a directory: ${root}`);
  walk(root);
  return files.sort((left, right) => {
    const a = path.relative(root, left).split(path.sep).join("/");
    const b = path.relative(root, right).split(path.sep).join("/");
    return a < b ? -1 : a > b ? 1 : 0;
  });
}

export function hashDistribution(root) {
  const hash = createHash("sha256").update("opensesame-distribution-v2\0");
  for (const file of distributionFiles(root)) {
    const relativePath = path.relative(root, file).split(path.sep).join("/");
    updateLengthPrefixed(hash, Buffer.from(relativePath), 4);
    updateLengthPrefixed(hash, fs.readFileSync(file), 8);
  }
  return hash.digest("hex");
}
