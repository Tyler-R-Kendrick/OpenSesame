/** Apply only reviewed native patches at exact pinned lines; no host patch tool. */
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const targets = {
  "native-toolchain.patch": ["go.toolchain.rev"],
  "native-node.patch": [
    "cmd/tsconnect/wasm/wasm_js.go",
    "net/tsdial/tsdial.go",
    "ipn/ipnlocal/node_backend.go",
  ],
  "disable-logtail.patch": ["cmd/tsconnect/wasm/wasm_js.go"],
  "native-peer-get.patch": ["cmd/tsconnect/wasm/wasm_js.go"],
  "exit-route.patch": ["cmd/tsconnect/wasmbuild/wasmbuild.go"],
  "native-ssh.patch": ["cmd/tsconnect/wasm/wasm_js.go"],
};
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
function requireValue(condition) {
  if (!condition) throw new Error("Pinned native patch input differs.");
}
function specification(pins, name) {
  switch (name) {
    case "native-toolchain.patch":
      return {
        digest: pins.toolchainSelection.patchSha256,
        files: [
          {
            path: "go.toolchain.rev",
            beforeSha256: pins.toolchainSelection.beforeRevisionSha256,
            afterSha256: pins.toolchainSelection.afterRevisionSha256,
          },
        ],
      };
    case "native-node.patch":
      return {
        digest: pins.nativeNode.files[1].sha256,
        files: pins.nativeNode.patchTargets,
      };
    case "disable-logtail.patch":
      return {
        digest: pins.privateLogging.patchSha256,
        files: [
          {
            path: targets[name][0],
            beforeSha256: pins.privateLogging.beforeSha256,
            afterSha256: pins.privateLogging.afterSha256,
          },
        ],
      };
    case "native-peer-get.patch":
      return {
        digest: pins.peerGET.patch.sha256,
        files: [
          {
            path: targets[name][0],
            beforeSha256: pins.peerGET.patch.beforeSha256,
            afterSha256: pins.peerGET.patch.afterSha256,
          },
        ],
      };
    case "exit-route.patch":
      return {
        digest: pins.patch.sha256,
        files: [
          {
            path: pins.patch.path,
            beforeSha256: pins.patch.beforeSha256,
            afterSha256: pins.patch.afterSha256,
          },
        ],
      };
    case "native-ssh.patch":
      return {
        digest: pins.nativeSSH.patch.sha256,
        files: [
          {
            path: targets[name][0],
            beforeSha256: pins.nativeSSH.patch.beforeSha256,
            afterSha256: pins.nativeSSH.patch.afterSha256,
          },
        ],
      };
    default:
      throw new Error("Native patch is outside the fixed reviewed scope.");
  }
}
function argumentsFor(args) {
  const patchPath = args.at(-1);
  const name = Object.keys(targets).find(
    (candidate) => patchPath === join(here, candidate),
  );
  requireValue(name);
  const expected = [
    "--batch",
    "--forward",
    ...(name === "disable-logtail.patch" ? ["--fuzz=0"] : []),
    "-p1",
    "-i",
    patchPath,
  ];
  requireValue(
    args.length === expected.length &&
      args.every((value, index) => value === expected[index]),
  );
  return name;
}
export function nativePatchCommand(program, args) {
  return program === "patch"
    ? {
        program: process.execPath,
        args: [join(here, "apply-native-patch.mjs"), ...args],
      }
    : { program, args };
}
function hunkHeader(line) {
  const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@$/.exec(line);
  requireValue(header);
  const hunk = {
    oldStart: Number(header[1]),
    oldCount: Number(header[2] ?? 1),
    newStart: Number(header[3]),
    newCount: Number(header[4] ?? 1),
    before: [],
    after: [],
  };
  return hunk;
}
function records(text) {
  requireValue(
    text.endsWith("\n") && !text.includes("\r") && text.length < 65536,
  );
  const lines = text.slice(0, -1).split("\n");
  const files = [];
  for (let cursor = 0; cursor < lines.length; ) {
    const from = /^--- a\/([a-zA-Z0-9_./-]+)$/.exec(lines[cursor++]);
    const to = /^\+\+\+ b\/([a-zA-Z0-9_./-]+)$/.exec(lines[cursor++]);
    requireValue(from && to && from[1] === to[1]);
    const hunks = [];
    while (cursor < lines.length && !lines[cursor].startsWith("--- ")) {
      const hunk = hunkHeader(lines[cursor++]);
      while (
        cursor < lines.length &&
        !lines[cursor].startsWith("@@ ") &&
        !lines[cursor].startsWith("--- ")
      ) {
        const line = lines[cursor++];
        requireValue([" ", "+", "-"].includes(line[0]));
        if (line[0] !== "+") hunk.before.push(line.slice(1));
        if (line[0] !== "-") hunk.after.push(line.slice(1));
      }
      requireValue(
        hunk.before.length === hunk.oldCount &&
          hunk.after.length === hunk.newCount,
      );
      hunks.push(hunk);
    }
    requireValue(hunks.length > 0);
    files.push({ path: from[1], hunks });
  }
  return files;
}
function changed(original, hunks) {
  requireValue(original.endsWith("\n"));
  const lines = original.slice(0, -1).split("\n");
  const output = [];
  let cursor = 0;
  for (const hunk of hunks) {
    const start = hunk.oldStart - (hunk.oldCount === 0 ? 0 : 1);
    requireValue(start >= cursor && start + hunk.oldCount <= lines.length);
    requireValue(
      hunk.before.every((line, index) => lines[start + index] === line),
    );
    output.push(...lines.slice(cursor, start));
    requireValue(
      hunk.newStart === output.length + (hunk.newCount === 0 ? 0 : 1),
    );
    output.push(...hunk.after);
    cursor = start + hunk.oldCount;
  }
  return `${[...output, ...lines.slice(cursor)].join("\n")}\n`;
}
async function ownedFile(source, path) {
  let directory = source;
  for (const part of ["", ...path.split("/").slice(0, -1)]) {
    directory = join(directory, part);
    const info = await lstat(directory);
    requireValue(info.isDirectory() && !info.isSymbolicLink());
  }
  const handle = await open(
    join(source, path),
    constants.O_RDWR | constants.O_NOFOLLOW,
  );
  try {
    const info = await handle.stat();
    requireValue(info.isFile() && info.nlink === 1 && info.size < 1048576);
    return { handle, bytes: await handle.readFile() };
  } catch (error) {
    await handle.close().catch(() => {});
    throw error;
  }
}
export async function applyNativePatch(source, args) {
  const name = argumentsFor(args);
  const pins = JSON.parse(await readFile(join(here, "source.json"), "utf8"));
  const spec = specification(pins, name);
  const patch = await readFile(join(here, name));
  requireValue(hash(patch) === spec.digest);
  const files = records(patch.toString("utf8"));
  requireValue(
    files.length === targets[name].length && spec.files.length === files.length,
  );
  const pending = [];
  let failure;
  try {
    for (const [index, file] of files.entries()) {
      const pin = spec.files[index];
      requireValue(
        file.path === targets[name][index] && file.path === pin.path,
      );
      const entry = await ownedFile(source, file.path);
      pending.push(entry);
      requireValue(hash(entry.bytes) === pin.beforeSha256);
      entry.after = Buffer.from(
        changed(entry.bytes.toString("utf8"), file.hunks),
      );
      requireValue(hash(entry.after) === pin.afterSha256);
    }
    // Validate every file before any write; there is no fuzzy search or fallback.
    for (const entry of pending) {
      const current = Buffer.alloc(entry.bytes.length);
      let offset = 0;
      while (offset < current.length) {
        const read = await entry.handle.read(
          current,
          offset,
          current.length - offset,
          offset,
        );
        requireValue(read.bytesRead > 0);
        offset += read.bytesRead;
      }
      requireValue(
        current.equals(entry.bytes) &&
          (await entry.handle.stat()).size === current.length,
      );
      await entry.handle.truncate(0);
      offset = 0;
      while (offset < entry.after.length) {
        const written = await entry.handle.write(
          entry.after,
          offset,
          entry.after.length - offset,
          offset,
        );
        requireValue(written.bytesWritten > 0);
        offset += written.bytesWritten;
      }
      await entry.handle.sync();
    }
  } catch (error) {
    failure = error;
  } finally {
    for (const entry of pending) {
      try {
        await entry.handle.close();
      } catch (error) {
        failure ??= error;
      }
    }
  }
  if (failure) throw failure;
  return name;
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const name = await applyNativePatch(process.cwd(), process.argv.slice(2));
  console.log(`Applied exact pinned native patch: ${name}`);
}
