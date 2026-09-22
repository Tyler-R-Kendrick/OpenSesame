import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import {
  META_UNSUPPORTED,
  approvedCapabilities,
  brokerOrigins,
  generateSecurityHeaders,
  main,
  readBrokerOrigins,
  renderHeadersFile,
} from "./security-headers.mjs";

const ORIGIN = "https://vault.example.test";
const BROKERS = ["https://shoo.dev"];

function policy(overrides = {}) {
  return {
    schemaVersion: 1,
    kind: "InstanceCapabilityPolicy",
    instanceId: "inst-test",
    revision: "1",
    presetProvenance: null,
    capabilities: {
      default: "deny",
      required: [],
      optional: [
        "backup.git-remote",
        "connectors.external",
        "access.authority",
      ],
      prohibited: ["telemetry.external"],
    },
    network: { externalServices: "deny", allowedServiceOrigins: [] },
    updates: {
      unknownCapabilities: "deny",
      expandedExposure: "require-approval",
    },
    ...overrides,
  };
}

function profile(instancePolicy, selectedOptional = []) {
  return {
    instancePolicy,
    installationSelection: {
      schemaVersion: 1,
      kind: "InstallationCapabilitySelection",
      instanceId: instancePolicy?.instanceId ?? "personal-local",
      installationId: "inst",
      basePolicyRevision: instancePolicy?.revision ?? "personal-local",
      revision: "1",
      acceptedRequired: instancePolicy?.capabilities.required ?? [],
      selectedOptional,
      chosenAlternatives: {},
      delivery: { prefetch: "none", offlineCache: "shell-only" },
    },
  };
}

function generate(p, overrides = {}) {
  return generateSecurityHeaders({
    profile: p,
    deploymentProfile: "dedicated_origin",
    canonicalOrigin: ORIGIN,
    headerSecurity: true,
    brokerOrigins: BROKERS,
    basePath: "/OpenSesame/",
    ...overrides,
  });
}

function directive(csp, name) {
  const found = csp
    .split(";")
    .map((d) => d.trim())
    .find((d) => d === name || d.startsWith(`${name} `));
  assert(found, `${name} present in ${csp}`);
  return found.slice(name.length).trim().split(/\s+/).filter(Boolean);
}

test("NET-06: header CSP carries frame-ancestors; the meta variant drops what browsers ignore", () => {
  const result = generate(profile(policy()));
  assert.deepEqual(directive(result.csp, "frame-ancestors"), ["'none'"]);
  assert.deepEqual(directive(result.csp, "frame-src"), ["'none'"]);
  assert.deepEqual(directive(result.csp, "worker-src"), ["'self'"]);
  assert.deepEqual(directive(result.csp, "script-src"), [
    "'self'",
    "'wasm-unsafe-eval'",
  ]);
  assert.equal(result.metaCsp.includes("frame-ancestors"), false);
  assert.deepEqual(result.unsupportedInMeta, [...META_UNSUPPORTED]);
  for (const name of META_UNSUPPORTED)
    assert.equal(result.metaCsp.includes(name), false);
  assert.equal(result.headers["Content-Security-Policy"], result.csp);
  assert.equal(result.headers["Cross-Origin-Opener-Policy"], "same-origin");
  assert.equal(result.headers["Cross-Origin-Embedder-Policy"], "require-corp");
  assert.equal(result.headers["Cross-Origin-Resource-Policy"], "same-origin");
  assert.equal(result.headers["Referrer-Policy"], "no-referrer");
  assert.equal(result.headers["X-Frame-Options"], "DENY");
});

test("NET-07: a strict profile has no http:/https: wildcard and no unlisted origin", () => {
  const result = generate(profile(policy()));
  const connect = directive(result.csp, "connect-src");
  assert.deepEqual(connect, ["'self'", ...BROKERS]);
  assert.equal(/\b(https?|wss?):(\s|;|$)/.test(result.csp), false, result.csp);
  assert.deepEqual(directive(result.csp, "form-action"), ["'self'"]);
});

test("NET-07: allowed service origins appear exactly, and an open allow is named as a widening", () => {
  const listed = generate(
    profile(
      policy({
        network: {
          externalServices: "allow",
          allowedServiceOrigins: ["https://id.example.test", "not-an-origin"],
        },
      }),
    ),
  );
  assert.deepEqual(directive(listed.csp, "connect-src"), [
    "'self'",
    ...BROKERS,
    "https://id.example.test",
  ]);
  const open = generate(
    profile(
      policy({
        network: { externalServices: "allow", allowedServiceOrigins: [] },
      }),
    ),
  );
  assert.ok(directive(open.csp, "connect-src").includes("https:"));
  assert.ok(open.notes.some((n) => n.includes("widened")));
});

test("NET-08: form-action follows approved navigation targets only", () => {
  const none = generate(profile(policy(), []));
  assert.deepEqual(directive(none.csp, "form-action"), ["'self'"]);
  const backup = generate(profile(policy(), ["backup.git-remote"]));
  assert.deepEqual(directive(backup.csp, "form-action"), [
    "'self'",
    "https://github.com",
  ]);
  const prohibited = generate(
    profile(
      policy({
        capabilities: {
          ...policy().capabilities,
          prohibited: ["backup.git-remote"],
        },
      }),
      ["backup.git-remote"],
    ),
  );
  assert.deepEqual(directive(prohibited.csp, "form-action"), ["'self'"]);
  const unpermitted = generate(profile(policy(), ["wallet.spending"]));
  assert.equal(
    unpermitted.approvedCapabilities.includes("wallet.spending"),
    false,
  );
  assert.deepEqual(
    approvedCapabilities(null).includes("vault.passwords"),
    true,
  );
});

test("NET-08: a purpose preset cannot move the deployment prerequisites", () => {
  const family = generate(
    profile(policy({ presetProvenance: { id: "family", version: 1 } })),
  );
  const managed = generate(
    profile(
      policy({
        presetProvenance: { id: "managed", version: 3 },
        network: {
          externalServices: "allow",
          allowedServiceOrigins: ["https://id.example.test"],
        },
      }),
      ["connectors.external"],
    ),
  );
  assert.equal(family.canonicalOrigin, managed.canonicalOrigin);
  assert.equal(family.deploymentProfile, managed.deploymentProfile);
  assert.equal(family.headerSecurity, managed.headerSecurity);
  for (const name of [
    "Cross-Origin-Opener-Policy",
    "Cross-Origin-Embedder-Policy",
    "Cross-Origin-Resource-Policy",
    "Referrer-Policy",
    "X-Frame-Options",
  ]) {
    assert.equal(family.headers[name], managed.headers[name]);
  }
  assert.notEqual(family.csp, managed.csp);
  assert.throws(() =>
    generate(profile(policy()), { deploymentProfile: "production" }),
  );
  assert.throws(() =>
    generate(profile(policy()), {
      canonicalOrigin: "https://vault.example.test/",
    }),
  );
  assert.throws(() =>
    generate(profile(policy()), { brokerOrigins: ["shoo.dev"] }),
  );
});

test("loopback development admits local dev sources; shared origin is marked meta-only", () => {
  const dev = generate(profile(policy()), {
    deploymentProfile: "loopback_development",
    canonicalOrigin: "http://localhost:5180",
    headerSecurity: false,
  });
  assert.ok(directive(dev.csp, "connect-src").includes("ws://localhost:*"));
  assert.equal(dev.csp.includes("upgrade-insecure-requests"), false);
  assert.ok(dev.notes.some((n) => n.includes("headerSecurity is false")));
  const pages = generate(profile(policy()), {
    deploymentProfile: "shared_origin_demo",
    canonicalOrigin: "https://tyler-r-kendrick.github.io",
    headerSecurity: false,
  });
  assert.ok(pages.csp.includes("upgrade-insecure-requests"));
  assert.equal(pages.metaCsp.includes("frame-ancestors"), false);
});

test("broker origins come from federation.ts and exclude the loopback mock", async () => {
  assert.deepEqual(
    brokerOrigins(
      'export const TRUSTED_UPSTREAMS = [ { issuer: "https://shoo.dev/x" }, { issuer: "http://127.0.0.1:9090" } ];',
    ),
    ["https://shoo.dev"],
  );
  assert.throws(() => brokerOrigins("nothing here"));
  const real = await readBrokerOrigins();
  assert.ok(real.includes("https://shoo.dev"));
  assert.equal(
    real.some((o) => o.startsWith("http://")),
    false,
  );
});

test("the _headers file carries the COOP exceptions and the CLI writes both artefacts", async () => {
  const result = generate(profile(policy()));
  const text = renderHeadersFile(result);
  assert.ok(text.startsWith("/*\n  Content-Security-Policy: "));
  assert.ok(
    text.includes(
      "/OpenSesame/identity/authorize\n  Cross-Origin-Opener-Policy: unsafe-none",
    ),
  );
  assert.ok(
    text.includes(
      "/OpenSesame/auth/redirect.html\n  ! Cross-Origin-Opener-Policy",
    ),
  );
  const dir = await mkdtemp(join(tmpdir(), "security-headers-"));
  const profilePath = join(dir, "profile.json");
  await import("node:fs/promises").then((fs) =>
    fs.writeFile(profilePath, JSON.stringify(profile(policy()))),
  );
  const emit = join(dir, "dist", "_headers");
  const out = await main(
    ["--profile", profilePath, "--emit", emit, "--base", "/OpenSesame/"],
    {
      PAGES_DEPLOYMENT_PROFILE: "dedicated_origin",
      PAGES_CANONICAL_ORIGIN: ORIGIN,
      PAGES_HEADER_SECURITY: "1",
    },
  );
  assert.equal(out.canonicalOrigin, ORIGIN);
  assert.equal(await readFile(emit, "utf8"), renderHeadersFile(out));
  const json = JSON.parse(
    await readFile(join(dir, "dist", "headers.json"), "utf8"),
  );
  assert.equal(json.csp, out.csp);
  assert.deepEqual(directive(json.csp, "connect-src"), [
    "'self'",
    "https://shoo.dev",
  ]);
});
