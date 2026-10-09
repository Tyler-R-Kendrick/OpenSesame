import assert from "node:assert/strict";
import { test } from "vitest";
import { generateSecurityHeaders } from "./security-headers.mjs";

function headers({
  approved = true,
  allow = true,
  listed = ["https://accounts.google.com"],
  enforced = false,
} = {}) {
  return generateSecurityHeaders({
    profile: {
      instancePolicy: {
        capabilities: {
          required: [],
          optional: ["connectors.external"],
          prohibited: [],
        },
        network: {
          externalServices: allow ? "allow" : "deny",
          allowedServiceOrigins: listed,
        },
      },
      installationSelection: {
        selectedOptional: approved ? ["connectors.external"] : [],
      },
    },
    canonicalOrigin: "https://selfhost.example",
    deploymentProfile: "dedicated_origin",
    headerSecurity: enforced,
  });
}
function sources(result, name) {
  return result.csp.split("; ").find((part) => part.startsWith(`${name} `));
}
test("GIS exact SDK and iframe sources are admitted only for an approved Google browser policy", () => {
  const allowed = headers();
  assert.equal(
    sources(allowed, "script-src"),
    "script-src 'self' 'wasm-unsafe-eval' https://accounts.google.com/gsi/client",
  );
  assert.equal(
    sources(allowed, "frame-src"),
    "frame-src https://accounts.google.com",
  );
  assert.equal(allowed.headers["Cross-Origin-Opener-Policy"], "same-origin");
  assert.equal(allowed.headers["Cross-Origin-Embedder-Policy"], "require-corp");
  assert.ok(allowed.metaCsp.includes("https://accounts.google.com/gsi/client"));
});
test.each([
  { approved: false },
  { allow: false },
  { listed: ["https://attacker.example"] },
  { enforced: true },
])(
  "GIS stays denied without the owning capability, Google egress, or compatible opener policy: %j",
  (input) => {
    const denied = headers(input);
    assert.equal(
      sources(denied, "script-src"),
      "script-src 'self' 'wasm-unsafe-eval'",
    );
    assert.equal(sources(denied, "frame-src"), "frame-src 'none'");
    assert.equal(denied.headers["Cross-Origin-Opener-Policy"], "same-origin");
  },
);
