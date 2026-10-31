import { readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import {
  isKnownCapability,
  optionalCapabilityIds,
} from "@opensesame/app-core/lib/capabilities/catalog.js";
import { describe, expect, it } from "vitest";
import {
  MIXED_MODULES,
  SOURCE_CLASSIFICATION,
  classify,
  ruleMatches,
} from "./classification.js";

const here = dirname(fileURLToPath(import.meta.url));
const pagesRoot = join(here, "..", "..", "..");

/** The shared core keeps the app's layout (ADR 0133); rules name it as `src/…`. */
const coreRoot = join(pagesRoot, "..", "..", "packages", "app-core");

function walk(dir: string, root = pagesRoot, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === "node_modules") continue;
      walk(full, root, out);
    } else if (/\.(ts|tsx|css|html)$/.test(name)) {
      out.push(relative(root, full).split("\\").join("/"));
    }
  }
  return out;
}

const SOURCES = [
  ...walk(join(pagesRoot, "src")),
  ...walk(join(coreRoot, "src"), coreRoot),
  ...walk(join(pagesRoot, "auth")),
  "index.html",
];

describe("SOURCE_CLASSIFICATION (S02-A)", () => {
  it("matches every source module the build sees", () => {
    const unmatched = SOURCES.filter((path) => classify(path) === null);
    expect(unmatched, `unclassified:\n${unmatched.join("\n")}`).toEqual([]);
  });

  it("keeps the auth-generation fence shared with core identity", () => {
    expect(classify("src/lib/ambient-auth/generation.ts")).toMatchObject({
      classification: "shared",
      capability: null,
    });
    expect(classify("src/lib/ambient-auth/controller.ts")).toMatchObject({
      classification: "optional",
      capability: "identity.ambient-sso",
    });
  });

  it("names only the custody metadata test family as core infrastructure", () => {
    const custody = classify("src/lib/vault-credential-custody.ts");
    expect(custody?.classification).toBe("core");
    expect(custody?.capability).toBeNull();
    expect(classify("src/lib/vault-credential-metadata.test.ts")).toMatchObject(
      {
        pattern: "src/lib/vault-credential-metadata.test",
        classification: custody?.classification,
        capability: null,
      },
    );
    for (const path of [
      "src/lib/vault-credential-metadata.ts",
      "src/lib/vault-credential-metadatas.test.ts",
      "src/lib/vault-credential-metadata-tests.ts",
      "src/lib/vault-credential-metadata.testament.ts",
    ])
      expect(classify(path), path).toBeNull();
    expect(
      classify("src/lib/secret-backends/encrypted-remote-continuity.ts"),
    ).toMatchObject({
      classification: "optional",
      capability: "connectors.external",
    });
  });

  it("owns only the configurable connector action test family", () => {
    const owner = classify("src/lib/connector-action-capability.test.ts");
    const configurable = classify(
      "src/lib/connector-action-configurable.test.ts",
    );
    expect(configurable).toMatchObject({
      pattern: "src/lib/connector-action-configurable.test",
      capability: "connectors.external",
      classification: owner?.classification,
    });
    for (const path of [
      "src/lib/connector-action-configurable.ts",
      "src/lib/connector-action-configurable.testament.ts",
      "src/lib/connector-action-configurables.test.ts",
    ])
      expect(classify(path), path).toBeNull();
  });

  it("owns only the SAML public settings regression test family", () => {
    expect(classify("src/lib/operator-saml-config.test.ts")).toMatchObject({
      pattern: "src/lib/operator-saml-config.test",
      classification: "core",
      capability: "settings.core",
    });
    for (const path of [
      "src/lib/operator-saml-config.ts",
      "src/lib/operator-saml-config.testament.ts",
      "src/lib/operator-saml-configuration.test.ts",
    ])
      expect(classify(path), path).toBeNull();
  });

  it("shares only the principal generation leaf while ambient acquisition stays optional", () => {
    expect(classify("src/lib/auth-generation.ts")).toMatchObject({
      pattern: "src/lib/auth-generation.ts",
      classification: "shared",
      capability: null,
    });
    for (const path of [
      "src/lib/auth-generation-helper.ts",
      "src/lib/auth-generation.test.ts",
      "src/lib/auth-generations.ts",
    ])
      expect(classify(path), path).toBeNull();
    for (const path of [
      "src/lib/ambient-auth/controller.ts",
      "src/lib/ambient-auth/oidc.ts",
    ])
      expect(classify(path), path).toMatchObject({
        classification: "optional",
        capability: "identity.ambient-sso",
      });
  });
  it("owns only the exact shell update and draft-retirement files", () => {
    for (const name of [
      "dirty-forms.ts",
      "dirty-forms.test.tsx",
      "load-shell.ts",
      "load-shell.test.ts",
      "shell-update.ts",
      "shell-update.test.ts",
      "stale-asset.ts",
      "sw-update-guard.ts",
      "dirty-edit.ts",
      "dirty-edit.test.ts",
      "stale-asset-reload.ts",
    ]) {
      expect(classify(`src/lib/${name}`), name).toMatchObject({
        pattern: `src/lib/${name}`,
        classification: "core",
        capability: "shell.navigation",
      });
    }
    for (const name of [
      "dirty-formats.ts",
      "dirty-editing.ts",
      "load-shell-helper.ts",
      "shell-updates.ts",
      "stale-asset-reloads.ts",
      "sw-update-guards.ts",
    ])
      expect(classify(`src/lib/${name}`), name).toBeNull();
  });

  it("keeps the Passwords offer optional and the native S3 fixture exactly scoped", () => {
    expect(classify("src/lib/pwa-offer-passwords-onboarding.ts")).toMatchObject(
      {
        pattern: "src/lib/pwa-offer-passwords-onboarding.ts",
        classification: "optional",
        capability: "vault.derived-records",
      },
    );
    expect(classify("src/lib/test/native-s3-backup-fixtures.ts")).toMatchObject(
      {
        pattern: "src/lib/test/native-s3-backup-fixtures.ts",
        classification: "optional",
        capability: "connectors.external",
      },
    );
    for (const path of [
      "src/lib/pwa-offer-passwords-onboarding-helper.ts",
      "src/lib/pwa-offer-passwords-onboardings.ts",
      "src/lib/test/native-s3-backup-fixture.ts",
      "src/lib/test/native-s3-backup-fixtures-other.ts",
      "src/lib/test/unowned-provider-fixtures.ts",
    ])
      expect(classify(path), path).toBeNull();
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
    const expectations = {
      "src/main.tsx": "core",
      "src/sw.ts": "install.pwa",
      "src/sw-push.ts": "notifications.web-push",
      "auth/redirect.html": "identity.ambient-sso",
      "auth/redirect-bridge.ts": "identity.ambient-sso",
      "src/lib/vault/website-pattern.worker.ts": "vault.passwords",
      "src/webmcp/tools.ts": "agents.webmcp",
      "src/webmcp/wallet-tools.ts": "wallet.spending",
      "src/screens/BrokerAuthorize.tsx": "identity.site-broker",
      "src/lib/local-guest.ts": "core",
      "src/lib/local-access-requests.ts": "access.authority",
      "src/lib/capabilities.ts": "settings.core",
      "src/lib/capabilities/catalog.ts": "core",
      "src/lib/self-hosted-config.ts": "connectors.external",
      "src/lib/self-hosted-config.test.ts": "connectors.external",
      "src/lib/self-hosted-connectors.ts": "connectors.external",
      "src/lib/self-hosted-connectors.test.ts": "connectors.external",
      "src/lib/self-hosted-connectors.durable.test.ts": "connectors.external",
      "src/lib/siop-social.ts": "identity.siop",
      "src/lib/connector-action-capability.ts": "connectors.external",
      "src/lib/connector-action-capability.test.ts": "connectors.external",
      "src/modules/sharing.drops/runtime.ts": "sharing.drops",
    };
    for (const [path, expected] of Object.entries(expectations)) {
      const rule = classify(path);
      const actual =
        expected === "core" ? rule?.classification : rule?.capability;
      expect(actual, path).toBe(expected);
    }
  });

  it("classifies what two optional capabilities both reach as shared, not as either's", () => {
    // Access draws the local directory's panels and the connector catalogue,
    // setup's federation steps draw connector cards: code reached from more
    // than one optional capability is owned by none of them (BUILD-04/05).
    for (const path of [
      "src/lib/der.ts",
      "src/lib/local-directory.ts",
      "src/lib/local-iam-access.ts",
      "src/lib/local-passkey-authentication.ts",
      "src/lib/local-sessions.ts",
      "src/lib/local-share-reach.ts",
      "src/lib/local-groups.ts",
      "src/lib/connections.ts",
      "src/lib/family-member-rows.test.ts",
      "src/lib/integration-ai-labs.test.ts",
      "src/lib/tailscale/browser-node-port.ts",
      "src/lib/tailscale/browser-node-store.ts",
      "src/lib/secret-backends/local-vault-port.ts",
      "src/lib/secret-backends/types.ts",
      "src/lib/vercel-connect.ts",
      "src/lib/generated-json.ts",
      "src/lib/generated-json.test.ts",
      "src/sections/identity/LocalApplicationSettings.tsx",
      "src/sections/identity/identity-views.ts",
      "src/sections/identity/HostedRecordParts.tsx",
      "src/sections/identity/hosted-identity-rail.ts",
      "src/screens/setup/steps/ConnectorCards.tsx",
      "node_modules/@vercel/connect",
      "node_modules/@opensesame/auth-upstream",
    ]) {
      const rule = classify(path);
      expect(rule?.classification, path).toBe("shared");
      expect(rule?.capability, path).toBeNull();
    }
    // The sections themselves stay with their capability.
    expect(classify("src/sections/IdentitySection.tsx")?.capability).toBe(
      "identity.local-iam",
    );
    expect(classify("src/sections/ConnectionsSection.tsx")?.capability).toBe(
      "connectors.external",
    );
    expect(
      classify("src/modules/access.authority/runtime.ts")?.capability,
    ).toBe("access.authority");
  });

  it("shares pinned native SDK metadata without promoting provider code", () => {
    const metadata = classify(
      "src/lib/secret-backends/onepassword-artifacts.json",
    );
    expect(metadata?.classification).toBe("shared");
    expect(metadata?.capability).toBeNull();
    expect(classify("src/lib/capabilities/ownership.ts")?.classification).toBe(
      "core",
    );
    for (const name of [
      "onepassword-sdk.ts",
      "onepassword-sdk-loader.ts",
      "onepassword-sdk-codec.ts",
      "onepassword-sdk-write.ts",
      "onepassword-sdk.worker.ts",
      "onepassword-worker-http.ts",
      "onepassword-worker-protocol.ts",
      "onepassword.ts",
      "onepassword-artifacts-other.json",
      "onepassword-artifacts.js",
    ]) {
      const rule = classify(`src/lib/secret-backends/${name}`);
      expect(rule?.classification, name).toBe("optional");
      expect(rule?.capability, name).toBe("connectors.external");
    }
  });

  it("classifies every exclusive package", () => {
    const expectations = {
      "node_modules/@azure/msal-browser/redirect-bridge":
        "identity.ambient-sso",
      "node_modules/@ag-ui/client": "support.remote-ai",
      "node_modules/ai": "support.local-ai",
      "node_modules/@ai-sdk/provider": "support.local-ai",
      "node_modules/kdbxweb": "vault.interop-formats",
      "node_modules/@nats-io/nkeys": "sharing.live",
      "node_modules/tweetnacl/nacl-fast.js": "sharing.live",
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

  it("keeps SIOP social optional and limits ownership to exact files", () => {
    expect(classify("src/lib/siop-social.ts")?.classification).toBe("optional");
    for (const path of [
      "src/lib/siop-social.test.ts",
      "src/lib/siop-social-helper.ts",
      "src/lib/local-groups.test.ts",
      "src/lib/local-groups-helper.ts",
      "src/lib/local-iam-access-helper.ts",
      "src/lib/local-passkey-authentication-helper.ts",
      "src/lib/family-member-rows.ts",
      "src/lib/integration-ai-labs-extra.test.ts",
    ])
      expect(classify(path), path).toBeNull();
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
