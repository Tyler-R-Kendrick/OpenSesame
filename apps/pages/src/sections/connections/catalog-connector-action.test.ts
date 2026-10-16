import { localGitToConnection } from "@opensesame/app-core/lib/connections-local-git.js";
/** @vitest-environment jsdom */
import { catalogProvider } from "@opensesame/app-core/lib/connector-catalog.js";
import { getBundledProviders } from "@opensesame/app-core/lib/embedded-catalog.js";
import { hasNativeConnectorDriver } from "@opensesame/app-core/lib/native-connector-drivers.js";
import { isSecretBackendProvider } from "@opensesame/app-core/lib/secret-backends/presets.js";
import { expect, it, vi } from "vitest";
import { catalogConnectorAction } from "./catalog-connector-action.js";
import { nativeSettingsDescriptor } from "./connect/NativeConnectorPanels.js";
import {
  connectorIntegration,
  installConnectorIntegration,
} from "./connect/native-connector-integration.test-support.js";

installConnectorIntegration();

function provider(id: string) {
  const found = catalogProvider(id);
  if (!found) throw new Error(`Provider not listed: ${id}`);
  return found;
}

it("does not offer browser authorization for legacy App or native git configuration routes", () => {
  connectorIntegration();
  // None of them is "a desktop app away": git has its own Backups road, and
  // the forges' OAuth needs a client secret a browser cannot hold.
  for (const id of ["git", "bitbucket", "origin"])
    expect(catalogConnectorAction(provider(id), null)).toMatchObject({
      kind: "unavailable",
      glyph: "blocked",
    });
  expect(catalogConnectorAction(provider("bitbucket"), null)).toMatchObject({
    reason: "needs-client-secret",
  });
  expect(catalogConnectorAction(provider("s3"), null)).toMatchObject({
    kind: "connect",
    glyph: "plus",
  });
  expect(catalogConnectorAction(provider("github"), null)).toMatchObject({
    kind: "connect",
    glyph: "plus",
    method: "api-key",
  });
});

it("keeps a saved local git URL from claiming browser installation or authorization", () => {
  const connection = localGitToConnection({
    id: "git_local_test",
    displayName: "Saved remote",
    remoteUrl: "https://github.com/example/repo.git",
    authMode: "https_token",
    username: "example",
    secretItemId: null,
    createdAt: "2026-10-09T00:00:00Z",
    updatedAt: "2026-10-09T00:00:00Z",
  });
  expect(connection.status).toBe("active");
  expect(connection.accountLabel).toContain("github.com");
  expect(catalogConnectorAction(provider("git"), connection)).toMatchObject({
    kind: "unavailable",
    glyph: "blocked",
  });
});

it("keeps Google cleanup compiled while refusing a new popup on an isolated browser", () => {
  connectorIntegration();
  vi.stubGlobal("crossOriginIsolated", true);
  try {
    expect(hasNativeConnectorDriver("oauth", "google")).toBe(true);
    const descriptor = nativeSettingsDescriptor(provider("google"));
    expect(
      descriptor?.methods.find((method) => method.id === "oauth")?.available,
    ).toBe(false);
    expect(catalogConnectorAction(provider("google"), null)).toMatchObject({
      kind: "unavailable",
      glyph: "blocked",
      reason: "no-contract",
    });
  } finally {
    vi.unstubAllGlobals();
  }
});

it("opens the common secret-backend experience for every bundled partner without claiming verification", () => {
  const backends = getBundledProviders().filter((row) =>
    isSecretBackendProvider(row.id),
  );
  expect(backends.some((row) => row.id === "bitwarden-secrets-manager")).toBe(
    true,
  );
  for (const backend of backends) {
    expect(catalogConnectorAction(backend, null)).toEqual({
      kind: "connect",
      glyph: "plus",
      method: "specialized",
    });
    const saved = {
      ...localGitToConnection({
        id: `test-${backend.id}`,
        displayName: "Saved configuration",
        remoteUrl: "https://example.com/backup.git",
        authMode: "https_token",
        username: "person",
        secretItemId: null,
        createdAt: "2026-10-14T00:00:00Z",
        updatedAt: "2026-10-14T00:00:00Z",
      }),
      providerId: backend.id,
    };
    expect(catalogConnectorAction(backend, saved)).toEqual({
      kind: "resume",
      glyph: "arrow",
      connectionId: saved.connectionId,
    });
  }
});
