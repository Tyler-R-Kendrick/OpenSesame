import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, unlinkSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

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
