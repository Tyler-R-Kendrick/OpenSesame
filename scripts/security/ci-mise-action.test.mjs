import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const workflowDir = join(root, ".github/workflows");
const { parse } = createRequire(import.meta.url)("yaml");

const miseUses = "jdx/mise-action@6612f0ef07ed2a736cd1e00a94a065522dd41195";
const miseLine =
  /uses:\s+jdx\/mise-action@6612f0ef07ed2a736cd1e00a94a065522dd41195 # v5\.2\.5\s*$/u;
const allowedArgs = new Set([
  "node",
  "node@24",
  "rust",
  "rust@1.94.0",
  "rust[components=miri]@nightly-2026-08-01",
  "go",
  "java",
  "cargo:cargo-ndk",
]);

function workflows() {
  return readdirSync(workflowDir)
    .filter((name) => name.endsWith(".yml"))
    .sort()
    .map((name) => ({
      name,
      text: readFileSync(join(workflowDir, name), "utf8"),
    }));
}

function nonComment(text) {
  return text
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("#"))
    .join("\n");
}

function runText(step) {
  return typeof step?.run === "string" ? step.run : "";
}

test("workflows do not set up Node with setup-node, pnpm, or corepack", () => {
  const files = workflows();
  assert.ok(files.length > 0);
  for (const { name, text } of files) {
    assert.doesNotMatch(text, /actions\/setup-node/u, name);
    assert.doesNotMatch(text, /pnpm\/action-setup/u, name);
    assert.doesNotMatch(text, /\bcorepack\b/u, name);
    assert.doesNotMatch(text, /setup-node/u, name);
    assert.doesNotMatch(text, /cache:\s*pnpm/u, name);
    assert.doesNotMatch(nonComment(text), /\bpnpm\b/u, name);
  }
});

test("npm jobs install Node with the pinned mise-action", () => {
  for (const { name, text } of workflows()) {
    const jobs = parse(text).jobs ?? {};
    let parsedMise = 0;
    for (const [id, job] of Object.entries(jobs)) {
      const steps = Array.isArray(job?.steps) ? job.steps : [];
      const label = `${name}:${id}`;
      const miseAt = [];
      let npmAt = -1;
      steps.forEach((step, index) => {
        if (step?.uses === miseUses) miseAt.push(index);
        if (npmAt < 0 && /\bnpm\s+(?:ci|run|exec)\b/u.test(runText(step))) {
          npmAt = index;
        }
      });
      parsedMise += miseAt.length;
      if (npmAt >= 0) {
        assert.ok(miseAt.length > 0, `${label} runs npm without mise`);
        assert.ok(miseAt[0] < npmAt, `${label} installs npm before mise`);
      }
      const body = JSON.stringify(job);
      const blocksRust = body.includes("dtolnay/rust-toolchain");
      const blocksGo = body.includes("actions/setup-go");
      const blocksJava = body.includes("JAVA_HOME_17_X64");
      const blocksNdk = body.includes("cargo install cargo-ndk");
      if (id === "analyze-native-go") {
        for (const index of miseAt) {
          const tokens = String(steps[index]?.with?.install_args ?? "")
            .split(/\s+/u)
            .filter((token) => token !== "");
          assert.equal(tokens.includes("go"), false, label);
        }
      }
      for (const index of miseAt) {
        const step = steps[index];
        assert.equal(step.with?.cache, true, label);
        const args = step.with?.install_args;
        assert.equal(typeof args, "string", label);
        const tokens = args.split(/\s+/u).filter((token) => token !== "");
        assert.ok(tokens.length > 0, label);
        for (const token of tokens) {
          assert.ok(allowedArgs.has(token), `${label} ${token}`);
        }
        assert.equal(tokens.includes("rust") && blocksRust, false, label);
        assert.equal(tokens.includes("go") && blocksGo, false, label);
        assert.equal(tokens.includes("java") && blocksJava, false, label);
        assert.equal(
          tokens.includes("cargo:cargo-ndk") && blocksNdk,
          false,
          label,
        );
        if (step.with.working_directory !== undefined) {
          const directory = step.with.working_directory;
          assert.equal(tokens.includes("node@24"), false, label);
          if (directory === "src") {
            assert.equal(
              tokens.includes("node") || tokens.includes("rust"),
              true,
              label,
            );
          } else {
            assert.equal(directory, "${{ runner.temp }}", label);
            assert.equal(tokens.includes("node"), false, label);
            assert.equal(
              tokens.some(
                (token) =>
                  token === "rust" ||
                  token.startsWith("rust@") ||
                  token.startsWith("rust["),
              ),
              true,
              label,
            );
          }
        }
      }
    }
    const rawMise = text
      .split("\n")
      .filter((line) => line.includes("jdx/mise-action@"));
    assert.equal(rawMise.length, parsedMise, name);
    for (const line of rawMise) assert.match(line, miseLine, name);
  }
});

function rustTokens(step) {
  if (step?.uses !== miseUses) return [];
  const args = step.with?.install_args;
  if (typeof args !== "string") return [];
  return args.split(/\s+/u).filter((token) => token !== "");
}

function installsRust(step) {
  return rustTokens(step).some(
    (token) =>
      token === "rust" ||
      token.startsWith("rust@") ||
      token.startsWith("rust["),
  );
}

function needsRust(step) {
  if (
    typeof step?.uses === "string" &&
    step.uses.startsWith("Swatinem/rust-cache@")
  ) {
    return true;
  }
  return /\b(?:cargo|rustup)\s+/u.test(runText(step));
}

test("workflows do not install Rust with dtolnay/rust-toolchain", () => {
  const files = workflows();
  assert.ok(files.length > 0);
  for (const { name, text } of files) {
    assert.doesNotMatch(text, /dtolnay\/rust-toolchain/u, name);
    assert.doesNotMatch(text, /rust-toolchain@/u, name);
  }
});

test("cargo jobs install Rust with the pinned mise-action", () => {
  for (const { name, text } of workflows()) {
    const jobs = parse(text).jobs ?? {};
    for (const [id, job] of Object.entries(jobs)) {
      const steps = Array.isArray(job?.steps) ? job.steps : [];
      const label = `${name}:${id}`;
      let needAt = -1;
      const rustAt = [];
      steps.forEach((step, index) => {
        if (needAt < 0 && needsRust(step)) needAt = index;
        if (installsRust(step)) rustAt.push(index);
      });
      if (needAt >= 0) {
        assert.ok(rustAt.length > 0, `${label} runs cargo without mise rust`);
        assert.ok(rustAt[0] < needAt, `${label} runs cargo before mise rust`);
      }
      assert.equal(
        JSON.stringify(job).includes("dtolnay/rust-toolchain"),
        false,
        label,
      );
    }
  }
});

function toolTokens(step) {
  return rustTokens(step);
}

function installsTool(step, name) {
  return toolTokens(step).includes(name);
}

function needsGo(step) {
  const run = runText(step);
  return (
    /\bgo\s+(?:build|test|list|mod|run)\b/u.test(run) ||
    /\btest:live-fixtures\b/u.test(run) ||
    /audit-crypto\.sh\b/u.test(run)
  );
}

function needsJava(step) {
  return /\bsdkmanager\b|\bgradle\b/u.test(runText(step));
}

function needsNdk(step) {
  return /build-core\.sh android\b/u.test(runText(step));
}

test("workflows do not install Go, Java, or cargo-ndk outside mise", () => {
  const files = workflows();
  assert.ok(files.length > 0);
  for (const { name, text } of files) {
    assert.doesNotMatch(text, /actions\/setup-go/u, name);
    assert.doesNotMatch(text, /go-version-file:/u, name);
    assert.doesNotMatch(text, /JAVA_HOME_17_X64/u, name);
    assert.doesNotMatch(text, /cargo install cargo-ndk/u, name);
    assert.doesNotMatch(text, /28\.0\.13004108/u, name);
    if (text.includes("sdkmanager")) {
      assert.match(text, /platforms;\$\{ANDROID_SDK_PLATFORM\}/u, name);
      assert.match(text, /build-tools;\$\{ANDROID_BUILD_TOOLS\}/u, name);
      assert.match(text, /build-tools;\$\{ANDROID_BUILD_TOOLS_LATEST\}/u, name);
      assert.match(text, /ndk;\$\{ANDROID_NDK_VERSION\}/u, name);
    }
  }
});

test("go, java, and cargo-ndk jobs install those tools with mise", () => {
  for (const { name, text } of workflows()) {
    const jobs = parse(text).jobs ?? {};
    for (const [id, job] of Object.entries(jobs)) {
      const steps = Array.isArray(job?.steps) ? job.steps : [];
      const label = `${name}:${id}`;
      const check = (needs, installs, tool) => {
        let needAt = -1;
        const at = [];
        steps.forEach((step, index) => {
          if (needAt < 0 && needs(step)) needAt = index;
          if (installs(step)) at.push(index);
        });
        if (needAt >= 0) {
          assert.ok(at.length > 0, `${label} needs mise ${tool}`);
          assert.ok(at[0] < needAt, `${label} uses ${tool} before mise`);
        }
      };
      if (id !== "analyze-native-go") {
        check(needsGo, (step) => installsTool(step, "go"), "go");
      }
      check(needsJava, (step) => installsTool(step, "java"), "java");
      check(
        needsNdk,
        (step) => installsTool(step, "cargo:cargo-ndk"),
        "cargo:cargo-ndk",
      );
    }
  }
});
