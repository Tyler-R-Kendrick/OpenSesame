import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const script = "scripts/dev/dotfiles-bootstrap.sh";
const defaultRepo = "https://github.com/Tyler-R-Kendrick/dotfiles.git";

function read(relativePath) {
  return readFileSync(join(root, relativePath), "utf8");
}

function uncommented(text) {
  return text
    .split("\n")
    .filter((line) => !line.trim().startsWith("#"))
    .join("\n");
}

function baseEnv(home, extra = {}) {
  const env = { ...process.env, HOME: home, ...extra };
  for (const key of Object.keys(env)) {
    if (key.startsWith("GIT_") || key === "DOTFILES_REPO") delete env[key];
  }
  env.HOME = home;
  env.GIT_AUTHOR_NAME = "Dotfiles Test";
  env.GIT_AUTHOR_EMAIL = "dotfiles-test@example.com";
  env.GIT_COMMITTER_NAME = env.GIT_AUTHOR_NAME;
  env.GIT_COMMITTER_EMAIL = env.GIT_AUTHOR_EMAIL;
  env.GIT_TERMINAL_PROMPT = "0";
  for (const [key, value] of Object.entries(extra)) env[key] = value;
  return env;
}

function layout(t) {
  const dir = mkdtempSync(join(tmpdir(), "dotfiles-bootstrap-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const home = join(dir, "home dir");
  const bin = join(dir, "bin");
  mkdirSync(join(dir, "scripts/dev"), { recursive: true });
  mkdirSync(home, { recursive: true });
  mkdirSync(bin, { recursive: true });
  const copy = join(dir, script);
  writeFileSync(copy, read(script), { mode: 0o755 });
  return { dir, home, bin, copy };
}

function tool(bin, name, body) {
  const path = join(bin, name);
  writeFileSync(path, body, { mode: 0o755 });
  chmodSync(path, 0o755);
  return path;
}

function installer(trace) {
  return `#!/bin/sh
set -eu
printf '%s\\n' "$0" >> ${JSON.stringify(trace)}
mkdir -p "$HOME/.local/bin"
printf '#!/bin/sh\\nprintf "mise fixture\\\\n"\\n' > "$HOME/.local/bin/mise"
printf '#!/bin/sh\\nprintf "grok fixture\\\\n"\\n' > "$HOME/.local/bin/grok"
chmod 755 "$HOME/.local/bin/mise" "$HOME/.local/bin/grok"
`;
}

function run(copy, env) {
  return spawnSync("bash", [copy], { env, encoding: "utf8" });
}

function assertTools(home) {
  const mise = join(home, ".local/bin/mise");
  const grok = join(home, ".local/bin/grok");
  assert.equal(statSync(mise).mode & 0o111, 0o111);
  assert.equal(statSync(grok).mode & 0o111, 0o111);
  const found = spawnSync(
    "bash",
    ["-c", "command -v mise && command -v grok && mise && grok"],
    {
      encoding: "utf8",
      env: {
        HOME: home,
        PATH: `${join(home, ".local/bin")}:/usr/bin:/bin`,
      },
    },
  );
  assert.equal(found.status, 0, found.stderr);
  assert.equal(found.stdout, `${mise}\n${grok}\nmise fixture\ngrok fixture\n`);
}

test("staging fallback installs mise and grok without network", (t) => {
  const f = layout(t);
  const trace = join(f.dir, "install-trace");
  const gitLog = join(f.dir, "git-log");
  const curlLog = join(f.dir, "curl-log");
  const sudoLog = join(f.dir, "sudo-log");
  const staging = join(f.dir, "staging/tyler-dotfiles");
  mkdirSync(staging, { recursive: true });
  writeFileSync(join(staging, "install.sh"), installer(trace), { mode: 0o755 });
  tool(
    f.bin,
    "git",
    `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(gitLog)}\nexit 128\n`,
  );
  tool(
    f.bin,
    "curl",
    `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(curlLog)}\nexit 99\n`,
  );
  tool(
    f.bin,
    "sudo",
    `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(sudoLog)}\nexit 99\n`,
  );
  const env = baseEnv(f.home, {
    PATH: `${f.bin}:${process.env.PATH}`,
    INSTALL_TRACE: trace,
  });
  const result = run(f.copy, env);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /clone failed; using /);
  assert.match(readFileSync(gitLog, "utf8"), new RegExp(defaultRepo));
  assert.equal(existsSync(curlLog), false);
  assert.equal(existsSync(sudoLog), false);
  assert.match(
    readFileSync(trace, "utf8"),
    /staging\/tyler-dotfiles\/install\.sh$/m,
  );
  assertTools(f.home);
  const again = run(f.copy, env);
  assert.equal(again.status, 0, again.stderr);
  assert.equal(existsSync(curlLog), false);
  assert.equal(existsSync(sudoLog), false);
  assert.equal(readFileSync(trace, "utf8").trim().split("\n").length, 2);
  assertTools(f.home);
});

test("a local clone is reused when a later refresh cannot reach the remote", (t) => {
  const f = layout(t);
  const trace = join(f.dir, "install-trace");
  const origin = join(f.dir, "origin");
  mkdirSync(join(origin, "empty"), { recursive: true });
  writeFileSync(join(origin, "install.sh"), installer(trace), { mode: 0o755 });
  const gitEnv = baseEnv(f.home, { PATH: process.env.PATH });
  execFileSync("git", ["init", "-b", "main"], { cwd: origin, env: gitEnv });
  execFileSync("git", ["add", "install.sh"], { cwd: origin, env: gitEnv });
  execFileSync(
    "git",
    ["-c", "core.hooksPath=/dev/null", "commit", "-m", "fixture"],
    { cwd: origin, env: gitEnv },
  );
  const env = baseEnv(f.home, {
    PATH: process.env.PATH,
    DOTFILES_REPO: origin,
  });
  const result = run(f.copy, env);
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stderr, /clone failed/);
  const checkout = join(f.home, ".local/share/opensesame/tyler-dotfiles");
  assert.equal(existsSync(join(checkout, ".git")), true);
  assertTools(f.home);
  rmSync(origin, { recursive: true, force: true });
  const again = run(f.copy, env);
  assert.equal(again.status, 0, again.stderr);
  assert.match(again.stderr, /refresh failed; using existing checkout/);
  assert.equal(readFileSync(trace, "utf8").trim().split("\n").length, 2);
  assertTools(f.home);
});

test("clone failure without a staging installer fails and keeps the previous binary", (t) => {
  const f = layout(t);
  const grok = join(f.home, ".local/bin/grok");
  mkdirSync(dirname(grok), { recursive: true });
  writeFileSync(grok, "previous\n");
  tool(f.bin, "git", "#!/bin/sh\nexit 128\n");
  tool(f.bin, "curl", "#!/bin/sh\nexit 99\n");
  const env = baseEnv(f.home, { PATH: `${f.bin}:${process.env.PATH}` });
  const missing = run(f.copy, env);
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /install\.sh is missing/);
  assert.equal(readFileSync(grok, "utf8"), "previous\n");
  const staging = join(f.dir, "staging/tyler-dotfiles");
  mkdirSync(staging, { recursive: true });
  writeFileSync(join(staging, "install.sh"), "#!/bin/sh\nexit 1\n", {
    mode: 0o755,
  });
  const failed = run(f.copy, env);
  assert.notEqual(failed.status, 0);
  assert.equal(readFileSync(grok, "utf8"), "previous\n");
});

test("bootstrap refuses a HOME it cannot write", (t) => {
  const f = layout(t);
  const missing = join(f.dir, "missing-home");
  const result = run(f.copy, baseEnv(missing, { PATH: process.env.PATH }));
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /HOME must be a writable directory/);
});

test("devcontainer and cloud install run dotfiles before npm ci via mise", () => {
  const source = uncommented(read(script));
  assert.match(source, new RegExp(defaultRepo.replaceAll(".", "\\.")));
  assert.match(source, /staging\/tyler-dotfiles/);
  assert.match(source, /bash "\$\{tree\}\/install\.sh"/);
  assert.doesNotMatch(source, /\bsudo\b/);
  assert.doesNotMatch(source, /curl[^\n]*\|\s*(?:ba)?sh/);
  const syntax = spawnSync("bash", ["-n", join(root, script)], {
    encoding: "utf8",
  });
  assert.equal(syntax.status, 0, syntax.stderr);
  const staged = join(root, "staging/tyler-dotfiles/install.sh");
  assert.equal(existsSync(staged), true);
  const stagedSyntax = spawnSync("bash", ["-n", staged], { encoding: "utf8" });
  assert.equal(stagedSyntax.status, 0, stagedSyntax.stderr);
  assert.doesNotMatch(
    uncommented(read("staging/tyler-dotfiles/install.sh")),
    /\bsudo\b/,
  );
  assert.doesNotMatch(
    uncommented(read("staging/tyler-dotfiles/install.sh")),
    /curl[^\n]*\|\s*(?:ba)?sh/,
  );

  const install = read(".cursor/install.sh");
  const installBoot = install.indexOf("bash scripts/dev/dotfiles-bootstrap.sh");
  const installLocked = install.indexOf("mise install --locked");
  const installDeps = install.indexOf("mise run deps");
  assert.ok(
    installBoot >= 0 &&
      installBoot < installLocked &&
      installLocked < installDeps,
  );
  assert.doesNotMatch(install, /\bcorepack\b|pnpm@/);
  assert.doesNotMatch(install, /curl[^\n]*\|\s*(?:ba)?sh/);

  const devcontainer = JSON.parse(read(".devcontainer/devcontainer.json"));
  const dockerfile = read(".devcontainer/Dockerfile");
  const cloud = read(".cursor/Dockerfile");
  assert.equal(devcontainer.features, undefined);
  assert.equal(devcontainer.mounts, undefined);
  assert.equal(JSON.stringify(devcontainer).includes("corepack"), false);
  assert.equal(JSON.stringify(devcontainer).includes("pnpm"), false);
  assert.equal(JSON.stringify(devcontainer).includes("features/node"), false);
  for (const name of [
    "MISE_VERSION",
    "MISE_SHA256_LINUX_X64",
    "MISE_SHA256_LINUX_ARM64",
  ]) {
    const pattern = new RegExp(`ARG ${name}=(\\S+)`);
    assert.equal(
      dockerfile.match(pattern)?.[1],
      cloud.match(pattern)?.[1],
      name,
    );
  }
  assert.match(dockerfile, /sha256sum -c --strict/);
  assert.match(dockerfile, /mise\.toml and mise\.lock/);
  assert.doesNotMatch(dockerfile, /mise\.run/);
  assert.doesNotMatch(dockerfile, /curl[^\n]*\|\s*(?:ba)?sh/);
  assert.match(
    dockerfile,
    /mcr\.microsoft\.com\/devcontainers\/rust:1-1-bookworm@sha256:[a-f0-9]{64}/,
  );
  for (const key of ["updateContentCommand", "postCreateCommand"]) {
    const text = devcontainer[key];
    const locked = text.indexOf("mise install --locked");
    const boot = text.indexOf("bash scripts/dev/dotfiles-bootstrap.sh");
    const deps = text.indexOf("mise run deps");
    assert.ok(locked >= 0 && locked < boot && boot < deps, key);
    assert.equal(text.includes("corepack"), false, key);
    assert.equal(
      text.includes("npm ci") || text.includes("mise run deps"),
      true,
      key,
    );
  }
  assert.ok(
    devcontainer.postCreateCommand.indexOf("setup-hooks.sh") >
      devcontainer.postCreateCommand.indexOf("mise run deps"),
  );
});
