import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { main, outputs } from "./candidate.mjs";
import { candidateOutputs, inventory } from "./lib/candidate-model.mjs";
import { POLICY } from "./lib/candidate-policy.mjs";

test("receipt envelope CLI remains token-free and binds the exact invocation", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "candidate-cli-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const output = join(directory, "outputs");
  const env = {
    GITHUB_ACTIONS: "true",
    GITHUB_REPOSITORY: POLICY.repository,
    GITHUB_REF: "refs/heads/main",
    GITHUB_EVENT_NAME: "schedule",
    GITHUB_WORKFLOW_REF: `${POLICY.repository}/.github/workflows/dev-nightly.yml@refs/heads/main`,
    GITHUB_WORKFLOW_SHA: "a".repeat(40),
    GITHUB_RUN_ID: "123",
    GITHUB_RUN_ATTEMPT: "2",
  };
  await main(
    [
      "receipt-envelope",
      "--stage",
      "dev",
      "--artifact-id",
      "456",
      "--artifact-digest",
      "b".repeat(64),
      "--output",
      output,
    ],
    env,
  );
  const text = await readFile(output, "utf8");
  const receipt = JSON.parse(text.slice("receipt=".length));
  assert.equal(receipt.run_id, "123");
  assert.equal(receipt.run_attempt, "2");
  assert.equal(receipt.artifact_id, "456");
});

test("CLI rejects inherited command names and unsupported options before admission", async () => {
  await assert.rejects(main(["__proto__"], {}), /Unknown candidate command/);
  await assert.rejects(
    main(["verify", "--skip-proof", "true"], {}),
    /Unsupported option/,
  );
});

test("the actual verified candidate outputs round-trip through the GitHub output writer", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "candidate-output-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const output = join(directory, "outputs");
  const manifest = {
    source_sha: "a".repeat(40),
    version: "1.2.3",
    payloads: [...inventory("1.2.3")].map(([path, [role, target]]) => ({
      path,
      role,
      target,
    })),
  };
  const values = candidateOutputs(directory, manifest);
  await outputs(values, output);
  const written = Object.fromEntries(
    (await readFile(output, "utf8"))
      .trimEnd()
      .split("\n")
      .map((line) => {
        const separator = line.indexOf("=");
        return [line.slice(0, separator), line.slice(separator + 1)];
      }),
  );
  assert.deepEqual(written, values);
  assert.equal(
    written.native_x86_archive,
    join(
      directory,
      "production/opensesame-kit_v1.2.3_x86_64-unknown-linux-gnu.tar.gz",
    ),
  );
  assert.ok(written.native_arm_archive);
  assert.ok(written.pages_archive);
});

test("unsafe output identifiers cannot inject or partially append GitHub output commands", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "candidate-output-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const output = join(directory, "outputs");
  await writeFile(output, "existing=value\n");
  for (const key of [
    "",
    "86_archive",
    "native-archive",
    "native archive",
    "native=forged",
    "native\ninjected",
    "native\rinjected",
    "native\n",
    "native\r",
    "native\r\n",
  ]) {
    await assert.rejects(
      outputs({ source_sha: "safe", [key]: "unsafe" }, output),
      /Unsafe GitHub output/,
    );
    assert.equal(await readFile(output, "utf8"), "existing=value\n");
  }
});

test("raw CR and LF in output values are rejected before any file append", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "candidate-output-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const output = join(directory, "outputs");
  await writeFile(output, "existing=value\n");
  for (const separator of ["\r", "\n", "\r\n"]) {
    await assert.rejects(
      outputs(
        { source_sha: "safe", pages_archive: `path${separator}injected=true` },
        output,
      ),
      /Unsafe GitHub output/,
    );
    assert.equal(await readFile(output, "utf8"), "existing=value\n");
  }
});
