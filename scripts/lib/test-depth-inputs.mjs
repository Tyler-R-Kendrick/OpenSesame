import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

function trackedBytes(path) {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink())
    return {
      kind: "symlink",
      bytes: readlinkSync(path, { encoding: "buffer" }),
    };
  if (stat.isFile()) return { kind: "file", bytes: readFileSync(path) };
  throw new Error(`Unexpected tracked input type: ${path}`);
}

export function sourceInputs(directory = process.cwd()) {
  const paths = execFileSync("git", ["ls-files", "-z"], {
    cwd: directory,
    encoding: "utf8",
  })
    .split("\0")
    .filter(Boolean)
    .sort();
  return paths.map((path) => {
    const { kind, bytes } = trackedBytes(join(directory, path));
    return {
      path,
      kind,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
  });
}

export function assertSameInputs(before, after) {
  if (JSON.stringify(before) !== JSON.stringify(after)) {
    throw new Error("Test-depth tracked inputs changed during execution");
  }
}

if (process.argv[1]?.endsWith("/test-depth-inputs.mjs")) {
  const [operation, destination] = process.argv.slice(2);
  if (!destination || !["capture", "check"].includes(operation)) {
    throw new Error("Expected capture/check and a private report path");
  }
  const inputs = sourceInputs();
  if (operation === "capture") {
    writeFileSync(destination, `${JSON.stringify(inputs, null, 2)}\n`);
  } else {
    assertSameInputs(JSON.parse(readFileSync(destination, "utf8")), inputs);
    console.log(`All ${inputs.length} tracked inputs unchanged.`);
  }
}
