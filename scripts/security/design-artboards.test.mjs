import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  cpSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const canvases = [
  "auth-flow",
  "first-run-setup",
  "pwa-install",
  "setup-next-steps",
  "shared-sessions",
];

for (const name of canvases) {
  test(`${name}: source inputs reproduce every canvas artboard deterministically`, (t) => {
    const scratch = mkdtempSync(join(tmpdir(), "design-artboards-"));
    t.after(() => rmSync(scratch, { recursive: true, force: true }));
    const directory = join(scratch, name);
    cpSync(join(root, "docs/design/canvases", name), directory, {
      recursive: true,
      filter: (source) => !source.endsWith(".dc.html"),
    });
    const build = () =>
      execFileSync(process.execPath, [join(directory, "build.mjs")], {
        stdio: ["ignore", "pipe", "pipe"],
      });
    build();
    const expected = JSON.parse(
      readFileSync(join(directory, "canvas.json"), "utf8"),
    )
      .artboards.map((board) => board.file)
      .sort();
    const generated = readdirSync(directory)
      .filter((file) => file.endsWith(".dc.html"))
      .sort();
    assert.deepEqual(generated, expected);
    const first = generated.map((file) => readFileSync(join(directory, file)));
    build();
    for (const [index, file] of generated.entries()) {
      assert.deepEqual(readFileSync(join(directory, file)), first[index]);
      assert.match(first[index].toString(), /<x-dc>/u);
    }
  });
}
