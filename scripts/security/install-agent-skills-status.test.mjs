import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

test("catalogue failure degrades currency, while a successful install remains ok", (t) => {
  const root = mkdtempSync(join(tmpdir(), "skills-install-status-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const put = (path, value) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), value);
  };
  mkdirSync(join(root, "scripts/dev"), { recursive: true });
  copyFileSync(
    fileURLToPath(new URL("../dev/install-agent-skills.sh", import.meta.url)),
    join(root, "scripts/dev/install-agent-skills.sh"),
  );
  put("scripts/dev/sync-agent-skills.mjs", "");
  put("skills-lock.json", JSON.stringify({ skills: { demo: { source: "example/demo" } } }));
  put(".codex/hooks.json", "{}\n");
  put(".claude/settings.json", "{}\n");
  put(".gitignore", ".agents/\nbin/\n");
  execFileSync("git", ["init", "-q", root]);
  execFileSync("git", ["-C", root, "add", "."]);
  execFileSync("git", ["-C", root, "-c", "user.name=test", "-c", "user.email=test@example.invalid", "commit", "-qm", "fixture"]);
  put("bin/npx", '#!/bin/sh\nif [ "$2" = skills@1.7.4 ] && [ "$3" = add ]; then exit 1; fi\nexit 0\n');
  chmodSync(join(root, "bin/npx"), 0o755);
  const run = () => execFileSync("bash", ["scripts/dev/install-agent-skills.sh"], {
    cwd: root,
    env: { ...process.env, PATH: `${join(root, "bin")}:${process.env.PATH}` },
    stdio: "pipe",
  });
  const status = () => JSON.parse(readFileSync(join(root, ".agents/.skills-currency.json"), "utf8")).status;
  run();
  assert.equal(status(), "degraded");
  put(".agents/skills/demo/SKILL.md", "# Demo\n");
  run();
  assert.equal(status(), "ok");
});
