import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { syncAgentSkills } from "../dev/sync-agent-skills.mjs";

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "agent-skills-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  function put(path, text) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return { root, put };
}

test("identical installs link once and canonical updates reach every alias", (t) => {
  const f = fixture(t);
  for (const agent of [".agents", ".claude", ".grok"])
    f.put(`${agent}/skills/example/SKILL.md`, "# Example\n");
  assert.equal(syncAgentSkills(f.root, { check: true }).length, 2);
  assert.equal(
    lstatSync(join(f.root, ".claude/skills/example")).isDirectory(),
    true,
  );
  assert.equal(syncAgentSkills(f.root).length, 2);
  assert.equal(syncAgentSkills(f.root, { check: true }).length, 0);
  f.put(".agents/skills/example/SKILL.md", "# Updated\n");
  assert.equal(
    readFileSync(join(f.root, ".claude/skills/example/SKILL.md"), "utf8"),
    "# Updated\n",
  );
  assert.equal(
    readFileSync(join(f.root, ".grok/skills/example/SKILL.md"), "utf8"),
    "# Updated\n",
  );
});

test("differing instructions and executable modes survive while shared payload links", (t) => {
  const f = fixture(t);
  f.put(".agents/skills/example/SKILL.md", "# Codex adapter\n");
  f.put(".claude/skills/example/SKILL.md", "# Claude adapter\n");
  for (const agent of [".agents", ".claude"]) {
    f.put(`${agent}/skills/example/shared.json`, "{}\n");
    f.put(`${agent}/skills/example/launcher`, "#!/bin/sh\n");
  }
  chmodSync(join(f.root, ".agents/skills/example/launcher"), 0o755);
  f.put(".claude/skills/example/unique.md", "# Keep this\n");
  syncAgentSkills(f.root);
  assert.equal(
    readFileSync(join(f.root, ".claude/skills/example/SKILL.md"), "utf8"),
    "# Claude adapter\n",
  );
  assert.equal(
    lstatSync(
      join(f.root, ".claude/skills/example/shared.json"),
    ).isSymbolicLink(),
    true,
  );
  assert.equal(
    lstatSync(join(f.root, ".claude/skills/example/launcher")).isSymbolicLink(),
    false,
  );
  assert.equal(
    existsSync(join(f.root, ".claude/skills/example/unique.md")),
    true,
  );
  assert.equal(syncAgentSkills(f.root, { check: true }).length, 0);
});

test("first-party canonical symlinks can back duplicate mirror installations", (t) => {
  const f = fixture(t);
  f.put("skills/example/SKILL.md", "# First-party\n");
  mkdirSync(join(f.root, ".agents/skills"), { recursive: true });
  symlinkSync(
    "../../skills/example",
    join(f.root, ".agents/skills/example"),
    "dir",
  );
  f.put(".claude/skills/example/SKILL.md", "# First-party\n");
  syncAgentSkills(f.root);
  assert.equal(
    realpathSync(join(f.root, ".claude/skills/example")),
    realpathSync(join(f.root, "skills/example")),
  );
});

test("unknown skills and escaping aliases are refused without removing local content", (t) => {
  const f = fixture(t);
  f.put(".claude/skills/unknown/SKILL.md", "# Keep\n");
  assert.throws(() => syncAgentSkills(f.root), /Choose a canonical/u);
  assert.equal(
    existsSync(join(f.root, ".claude/skills/unknown/SKILL.md")),
    true,
  );
  rmSync(join(f.root, ".claude/skills/unknown"), { recursive: true });
  f.put(".agents/skills/example/SKILL.md", "# Example\n");
  symlinkSync(tmpdir(), join(f.root, ".claude/skills/example"), "dir");
  assert.throws(() => syncAgentSkills(f.root), /Unexpected skill alias/u);
});

function writeProfiles(f, profiles) {
  f.put(
    "skills/profiles.json",
    `${JSON.stringify({ version: 1, profiles }, null, 2)}\n`,
  );
}

test("optional skill absent everywhere passes core validation", (t) => {
  const f = fixture(t);
  writeProfiles(f, {
    core: { skills: [] },
    "reusable-optional": { skills: ["opt-example"] },
  });
  assert.equal(syncAgentSkills(f.root, { check: true }).length, 0);
  // Stale harness mirror for an uninstalled optional skill is tolerated here;
  // removing it belongs to the harness workflow.
  f.put(".claude/skills/opt-example/SKILL.md", "# Stale\n");
  assert.equal(syncAgentSkills(f.root, { check: true }).length, 0);
});

test("optional skill under skills-optional links like the default root", (t) => {
  const f = fixture(t);
  writeProfiles(f, {
    core: { skills: [] },
    "reusable-optional": { skills: ["opt-example"] },
  });
  f.put(".agents/skills-optional/opt-example/SKILL.md", "# Opt\n");
  f.put(".claude/skills/opt-example/SKILL.md", "# Opt\n");
  syncAgentSkills(f.root);
  assert.equal(
    realpathSync(join(f.root, ".claude/skills/opt-example")),
    realpathSync(join(f.root, ".agents/skills-optional/opt-example")),
  );
  assert.equal(syncAgentSkills(f.root, { check: true }).length, 0);
});

test("core skill missing its .agents alias fails", (t) => {
  const f = fixture(t);
  writeProfiles(f, { core: { skills: ["core-example"] } });
  f.put("skills/core-example/SKILL.md", "# Core\n");
  mkdirSync(join(f.root, ".agents/skills"), { recursive: true });
  assert.throws(
    () => syncAgentSkills(f.root, { check: true }),
    /Missing core alias/u,
  );
  symlinkSync(
    "../../skills/core-example",
    join(f.root, ".agents/skills/core-example"),
    "dir",
  );
  assert.equal(syncAgentSkills(f.root, { check: true }).length, 0);
});

test("shared Impeccable launcher retains Claude-specific reference directory", (t) => {
  const probeRoot = fileURLToPath(new URL("../..", import.meta.url));
  if (
    !existsSync(join(probeRoot, ".claude/skills/impeccable/scripts/impeccable"))
  ) {
    t.skip("impeccable (reusable-optional) not installed");
    return;
  }
  const f = fixture(t);
  const root = fileURLToPath(new URL("../..", import.meta.url));
  const stub = join(f.root, "engine");
  writeFileSync(stub, '#!/bin/sh\nprintf "%s\\n" "$IMPECCABLE_SKILL_DIR"\n');
  chmodSync(stub, 0o755);
  const output = execFileSync(
    "sh",
    [
      join(root, ".claude/skills/impeccable/scripts/impeccable"),
      "engine-probe",
    ],
    {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, IMPECCABLE_BIN: stub, IMPECCABLE_SKILL_DIR: "" },
    },
  ).trim();
  assert.equal(output, join(root, ".claude/skills/impeccable"));
});

test("sync preserves a personal mirror of an uninstalled optional skill", (t) => {
  const f = fixture(t);
  writeProfiles(f, {
    core: { skills: [] },
    "reusable-optional": { skills: ["opt-example"] },
  });
  f.put(".claude/skills/opt-example/SKILL.md", "# Stale\n");
  assert.equal(syncAgentSkills(f.root, { check: true }).length, 0);
  syncAgentSkills(f.root);
  assert.equal(
    readFileSync(join(f.root, ".claude/skills/opt-example/SKILL.md"), "utf8"),
    "# Stale\n",
  );
});

test("sync refuses an escaped mirror root without deleting external files", (t) => {
  const f = fixture(t);
  const external = mkdtempSync(join(tmpdir(), "personal-skills-"));
  t.after(() => rmSync(external, { recursive: true, force: true }));
  writeProfiles(f, {
    core: { skills: [] },
    "reusable-optional": { skills: ["opt-example"] },
  });
  mkdirSync(join(f.root, ".claude"), { recursive: true });
  mkdirSync(join(external, "opt-example"));
  writeFileSync(join(external, "opt-example/SKILL.md"), "# Personal\n");
  symlinkSync(external, join(f.root, ".claude/skills"), "dir");
  assert.throws(
    () => syncAgentSkills(f.root),
    /Skill path escapes repository/u,
  );
  assert.equal(
    readFileSync(join(external, "opt-example/SKILL.md"), "utf8"),
    "# Personal\n",
  );
});

test("sync prunes dangling mirror links left by an upstream removal", (t) => {
  const f = fixture(t);
  writeProfiles(f, {
    core: { skills: [] },
    "reusable-optional": { skills: ["opt-example"] },
  });
  f.put(".agents/skills/opt-example/SKILL.md", "# Opt\n");
  f.put(".claude/skills/opt-example/SKILL.md", "# Variant\n");
  symlinkSync(
    "../../../.agents/skills/opt-example/removed-upstream.md",
    join(f.root, ".claude/skills/opt-example/removed-upstream.md"),
    "file",
  );
  syncAgentSkills(f.root);
  assert.equal(
    existsSync(join(f.root, ".claude/skills/opt-example/removed-upstream.md")),
    false,
  );
  assert.equal(
    readFileSync(join(f.root, ".claude/skills/opt-example/SKILL.md"), "utf8"),
    "# Variant\n",
  );
});

test("unlisted canonical warns locally and fails in CI", (t) => {
  const f = fixture(t);
  writeProfiles(f, { core: { skills: [] } });
  f.put(".agents/skills/zz-personal/SKILL.md", "# Personal\n");
  const previous = process.env.CI;
  try {
    process.env.CI = "";
    assert.equal(syncAgentSkills(f.root, { check: true }).length, 0);
    process.env.CI = "true";
    assert.throws(
      () => syncAgentSkills(f.root, { check: true }),
      /not listed in skills\/profiles\.json/u,
    );
  } finally {
    process.env.CI = previous ?? "";
  }
});
