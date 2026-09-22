import { readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { isKnownCapability, optionalCapabilityIds } from "./catalog.js";
import {
  MIXED_MODULES,
  SOURCE_CLASSIFICATION,
  classify,
  ruleMatches,
} from "./classification.js";

const here = dirname(fileURLToPath(import.meta.url));
const pagesRoot = join(here, "..", "..", "..");

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === "node_modules") continue;
      walk(full, out);
    } else if (/\.(ts|tsx|css|html)$/.test(name)) {
      out.push(relative(pagesRoot, full).split("\\").join("/"));
    }
  }
  return out;
}

const SOURCES = [
  ...walk(join(pagesRoot, "src")),
  ...walk(join(pagesRoot, "auth")),
  "index.html",
];

describe("SOURCE_CLASSIFICATION (S02-A)", () => {
  it("matches every source module the build sees", () => {
    const unmatched = SOURCES.filter((path) => classify(path) === null);
    expect(unmatched, `unclassified:\n${unmatched.join("\n")}`).toEqual([]);
  });

  it("has unique patterns", () => {
    const patterns = SOURCE_CLASSIFICATION.map((rule) => rule.pattern);
    expect(new Set(patterns).size).toBe(patterns.length);
  });

  it("optional rules name a known optional capability; shared rules name none", () => {
    const optional = new Set(optionalCapabilityIds());
    for (const rule of SOURCE_CLASSIFICATION) {
      if (rule.classification === "optional") {
        expect(optional.has(rule.capability ?? ""), rule.pattern).toBe(true);
      } else if (rule.classification === "shared") {
        expect(rule.capability, rule.pattern).toBeNull();
      } else if (rule.capability !== null) {
        expect(isKnownCapability(rule.capability), rule.pattern).toBe(true);
      }
      expect(rule.rationale.length, rule.pattern).toBeGreaterThan(3);
    }
  });

  it("classifies the executable roots the way ownership.md records them", () => {
    expect(classify("src/main.tsx")?.classification).toBe("core");
    expect(classify("src/sw.ts")?.capability).toBe("install.pwa");
    expect(classify("src/sw-push.ts")?.capability).toBe(
      "notifications.web-push",
    );
    expect(classify("auth/redirect.html")?.capability).toBe(
      "identity.ambient-sso",
    );
    expect(classify("auth/redirect-bridge.ts")?.capability).toBe(
      "identity.ambient-sso",
    );
    expect(
      classify("src/lib/vault/website-pattern.worker.ts")?.capability,
    ).toBe("vault.passwords");
    expect(classify("src/webmcp/tools.ts")?.capability).toBe("agents.webmcp");
    expect(classify("src/webmcp/wallet-tools.ts")?.capability).toBe(
      "wallet.spending",
    );
    expect(classify("src/screens/BrokerAuthorize.tsx")?.capability).toBe(
      "identity.site-broker",
    );
    expect(classify("src/lib/local-guest.ts")?.classification).toBe("core");
    expect(classify("src/lib/local-directory.ts")?.capability).toBe(
      "identity.local-iam",
    );
    expect(classify("src/lib/local-access-requests.ts")?.capability).toBe(
      "access.authority",
    );
    expect(classify("src/lib/capabilities.ts")?.capability).toBe(
      "connectors.external",
    );
    expect(classify("src/lib/capabilities/catalog.ts")?.classification).toBe(
      "core",
    );
    expect(classify("src/modules/sharing.drops/runtime.ts")?.capability).toBe(
      "sharing.drops",
    );
  });

  it("classifies every exclusive package", () => {
    const expectations: Record<string, string> = {
      "node_modules/@azure/msal-browser/redirect-bridge":
        "identity.ambient-sso",
      "node_modules/@vercel/connect": "connectors.external",
      "node_modules/@ag-ui/client": "support.remote-ai",
      "node_modules/ai": "support.local-ai",
      "node_modules/@ai-sdk/provider": "support.local-ai",
      "node_modules/driver.js/hints": "support.guided-help",
      "node_modules/kdbxweb": "vault.interop-formats",
      "node_modules/simple-icons": "connectors.external",
      "node_modules/@opensesame/wallet-consent/verify": "wallet.spending",
      "node_modules/@opensesame/siop-v2": "identity.siop",
      "node_modules/@opensesame/webmcp": "agents.webmcp",
      "node_modules/@opensesame/support-agent": "support.guided-help",
      "node_modules/@opensesame/guide-lang": "support.guided-help",
    };
    for (const [pkg, capability] of Object.entries(expectations)) {
      expect(classify(pkg)?.capability, pkg).toBe(capability);
    }
    expect(classify("node_modules/@opensesame/qr")?.classification).toBe(
      "shared",
    );
    expect(classify("node_modules/react")?.classification).toBe("core");
    // `ai` must not swallow `@ai-sdk/*` or `age-encryption`.
    expect(classify("node_modules/age-encryption")?.capability).toBe(
      "backup.cloud-secrets",
    );
  });

  it("prefix matching continues only on '.', '-' or '/'", () => {
    expect(ruleMatches("src/lib/push", "src/lib/push.ts")).toBe(true);
    expect(ruleMatches("src/lib/push", "src/lib/push.test.ts")).toBe(true);
    expect(ruleMatches("src/lib/push", "src/lib/pushy.ts")).toBe(false);
    expect(ruleMatches("src/lib/local-", "src/lib/local-rbac.ts")).toBe(true);
    expect(ruleMatches("src/lib/vault/", "src/lib/vault/store.ts")).toBe(true);
    expect(ruleMatches("node_modules/ai", "node_modules/ai/index.js")).toBe(
      true,
    );
    expect(ruleMatches("node_modules/ai", "node_modules/aix")).toBe(false);
  });

  it("every mixed module exists, is classified, and names known capabilities", () => {
    const sources = new Set(SOURCES);
    for (const mixed of MIXED_MODULES) {
      expect(sources.has(mixed.path), mixed.path).toBe(true);
      expect(classify(mixed.path), mixed.path).not.toBeNull();
      expect(mixed.extract.length, mixed.path).toBeGreaterThan(0);
      for (const extraction of mixed.extract) {
        expect(isKnownCapability(extraction.capability), mixed.path).toBe(true);
      }
    }
  });

  it("an optional rule never classifies an executable root as harmless shared", () => {
    for (const root of [
      "src/main.tsx",
      "src/app-root.tsx",
      "src/sw.ts",
      "index.html",
    ]) {
      expect(classify(root)?.classification, root).toBe("core");
    }
  });
});
