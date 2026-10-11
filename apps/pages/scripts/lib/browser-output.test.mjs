import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "vitest";
import { keepBrowserOutput } from "./browser-output.mjs";

const crash =
  "2026-10-11T05:46:01.000Z pw:browser [pid=42][err] WebProcess CRASHED\n";

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "browser-output-"));
  const file = path.join(dir, "browsers.log");
  const passed = [];
  const stream = {
    write(chunk) {
      passed.push(String(chunk));
      return true;
    },
  };
  keepBrowserOutput(file, stream);
  return { file, passed, stream };
}

test("a browser's lines go to the file, the walk's stay on the stream", () => {
  const { file, passed, stream } = fixture();
  stream.write("PASS chromium>webkit a sealed request code\n");
  stream.write(Buffer.from(crash));
  stream.write("\n1 failure(s):\n");
  assert.deepEqual(passed, [
    "PASS chromium>webkit a sealed request code\n",
    "\n1 failure(s):\n",
  ]);
  assert.equal(fs.readFileSync(file, "utf8"), crash);
});

test("a diverted line still answers its callback, in either position", () => {
  const { stream } = fixture();
  let answered = 0;
  assert.equal(
    stream.write(crash, () => answered++),
    true,
  );
  stream.write(crash, "utf8", () => answered++);
  assert.equal(answered, 2);
});

test("with no browser line nothing is written", () => {
  const { file, passed, stream } = fixture();
  stream.write("PASS webkit>webkit ending dropped the value\n");
  assert.equal(passed.length, 1);
  assert.equal(fs.existsSync(file), false);
});
