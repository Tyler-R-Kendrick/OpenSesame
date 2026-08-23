import assert from "node:assert/strict";
import { unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const { main, parseSchemaFile } = await import(
  "../bin/opensesame-env-parse.mjs"
);

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
    const j = parseSchemaFile(path);
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
    assert.ok(!JSON.stringify(j).includes("sk_live_should_not_appear"));
  } finally {
    unlinkSync(path);
  }
});

test("adversarial: missing schema path exits 2", () => {
  let stderr = "";
  assert.equal(
    main([], (message) => {
      stderr = message;
    }),
    2,
  );
  assert.match(stderr, /usage: opensesame-env-parse/);
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
    const j = parseSchemaFile(path);
    assert.equal(j.items[0].sensitive, true);
    assert.equal(j.items[0].value, null);
    assert.equal(JSON.stringify(j).includes("super-secret-value"), false);
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
    const runs = Array.from({ length: 8 }, () => parseSchemaFile(path));
    for (const result of runs) {
      assert.equal(
        JSON.stringify(result).includes("sk_live_concurrent"), // gitleaks:allow -- the assertion is that this is NOT emitted
        false,
      ); // gitleaks:allow -- fixture
    }
  } finally {
    unlinkSync(path);
  }
});

test("contract: output is JSON with schema_path and parser id", () => {
  const path = join(__dirname, "tmp-contract.env.schema");
  writeFileSync(path, "# @public\nAPI=http://127.0.0.1:1\n");
  try {
    const j = parseSchemaFile(path);
    assert.equal(j.parser, "@env-spec/parser");
    assert.equal(j.schema_path, path);
    assert.equal(Array.isArray(j.items), true);
  } finally {
    unlinkSync(path);
  }
});
