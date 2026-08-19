import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const bin = join(__dirname, "../bin/opensesame-env-parse.mjs");

test("parses schema without leaking sensitive static values", () => {
  const path = join(__dirname, "tmp.env.schema");
  writeFileSync(
    path,
    `# @defaultSensitive=false
# ---

# @type=url
# @public
API_URL=http://localhost:3000

# @required @sensitive
# @type=string(startsWith="sk_")
STRIPE_SECRET_KEY=opensesameConnection(conn://demo/stripe, projection=legacy-token)

# @required @sensitive
# DO NOT COMMIT REAL TOKENS
LEAKY=sk_live_should_not_appear_when_sensitive
`,
  );
  try {
    const r = spawnSync(process.execPath, [bin, path], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    const j = JSON.parse(r.stdout);
    assert.equal(j.items.length, 3);
    const api = j.items.find((i) => i.key === "API_URL");
    assert.equal(api.value, "http://localhost:3000");
    assert.equal(api.public, true);
    const stripe = j.items.find((i) => i.key === "STRIPE_SECRET_KEY");
    assert.equal(stripe.sensitive, true);
    assert.equal(stripe.value, null);
    assert.equal(stripe.resolver.fn, "opensesameConnection");
    const leaky = j.items.find((i) => i.key === "LEAKY");
    assert.equal(leaky.sensitive, true);
    assert.equal(leaky.value, null);
    assert.ok(!r.stdout.includes("sk_live_should_not_appear"));
  } finally {
    unlinkSync(path);
  }
});

test("adversarial: missing schema path exits 2", () => {
  const r = spawnSync(process.execPath, [bin], { encoding: "utf8" });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /usage: opensesame-env-parse/);
});

test("property: @sensitive static values are always null", () => {
  const path = join(__dirname, "tmp-sensitive.env.schema");
  writeFileSync(
    path,
    `# @defaultSensitive=false
# ---

# @sensitive
# @type=string
LEAK=super-secret-value
`,
  );
  try {
    const r = spawnSync(process.execPath, [bin, path], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    const j = JSON.parse(r.stdout);
    assert.equal(j.items[0].sensitive, true);
    assert.equal(j.items[0].value, null);
    assert.equal(r.stdout.includes("super-secret-value"), false);
  } finally {
    unlinkSync(path);
  }
});

test("chaos: concurrent parses of one schema stay secret-free", () => {
  const path = join(__dirname, "tmp-concurrent.env.schema");
  writeFileSync(
    path,
    `# @sensitive
TOKEN=sk_live_concurrent # gitleaks:allow -- fixture
`,
  );
  try {
    const runs = Array.from({ length: 8 }, () =>
      spawnSync(process.execPath, [bin, path], { encoding: "utf8" }),
    );
    for (const r of runs) {
      assert.equal(r.status, 0, r.stderr);
      assert.equal(r.stdout.includes("sk_live_concurrent"), false); // gitleaks:allow -- fixture
    }
  } finally {
    unlinkSync(path);
  }
});

test("contract: output is JSON with schema_path and parser id", () => {
  const path = join(__dirname, "tmp-contract.env.schema");
  writeFileSync(path, "# @public\nAPI=http://127.0.0.1:1\n");
  try {
    const r = spawnSync(process.execPath, [bin, path], { encoding: "utf8" });
    const j = JSON.parse(r.stdout);
    assert.equal(j.parser, "@env-spec/parser");
    assert.equal(j.schema_path, path);
    assert.equal(Array.isArray(j.items), true);
  } finally {
    unlinkSync(path);
  }
});
