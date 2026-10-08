/** @vitest-environment jsdom */
import { afterEach, expect, it, vi } from "vitest";
import { acquireEntraSilent, entraSeams } from "./ambient-auth/entra.js";
import { providerConnectionKey } from "./ambient-auth/provider.js";
import { unregisterServiceWorkers } from "./browser-reset-areas.js";
import { decoyGuardedFetch } from "./decoy-fetch.js";
import { markDecoySession } from "./decoy-session.js";
import { claimGithubAppCode } from "./github-app-claim.js";
import { listGithubAppInstallationRepos } from "./github-app-repos.js";
import {
  deliveredModels,
  hostedInferenceSeams,
  performInference,
} from "./hosted-inference.js";
import { syncVaultBackup, vaultBackupSyncSeams } from "./vault-backup-sync.js";
import { relayFetch } from "./vercel-connect-relay.js";

afterEach(() => {
  markDecoySession(false);
  vi.restoreAllMocks();
});
it("refuses direct relay, backup, GitHub, reset and inference paths before their transports", async () => {
  const network = vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValue(new Response("{}"));
  const backup = vi.spyOn(vaultBackupSyncSeams, "putContents");
  const inference = vi.spyOn(hostedInferenceSeams, "fetch");
  markDecoySession(true);
  await expect(relayFetch("/api/connectors")).rejects.toThrow(
    "authenticate again",
  );
  await expect(syncVaultBackup()).rejects.toThrow("authenticate again");
  await expect(claimGithubAppCode("code", "state")).rejects.toThrow(
    "authenticate again",
  );
  await expect(listGithubAppInstallationRepos()).rejects.toThrow(
    "authenticate again",
  );
  await expect(
    unregisterServiceWorkers("https://vault.example/"),
  ).rejects.toThrow("authenticate again");
  expect(() => performInference("openai")).toThrow("authenticate again");
  expect(() =>
    hostedInferenceSeams.deliver({
      ok: true,
      providerId: "openai",
      operation: "model.infer",
      url: "https://api.example/",
      headers: { authorization: "Bearer production" },
      body: {},
    }),
  ).toThrow("authenticate again");
  expect(deliveredModels()).toEqual([]);
  expect(network).not.toHaveBeenCalled();
  expect(backup).not.toHaveBeenCalled();
  expect(inference).not.toHaveBeenCalled();
});
it("withholds raw responses completing after decoy entry", async () => {
  let finish: (response: Response) => void = () => undefined;
  vi.spyOn(globalThis, "fetch").mockImplementation(
    () =>
      new Promise<Response>((resolve) => {
        finish = resolve;
      }),
  );
  const pending = decoyGuardedFetch("https://relay.example/");
  markDecoySession(true);
  finish(new Response("member data"));
  await expect(pending).rejects.toThrow("authenticate again");
});
it("refuses silent Entra acquisition before loading ambient SDK accounts", async () => {
  const sdk = vi.spyOn(entraSeams, "loadSdk");
  markDecoySession(true);
  await expect(
    acquireEntraSilent(
      {
        connection: {
          key: providerConnectionKey({
            protocol: "entra",
            issuer: "https://login.microsoftonline.com/test/v2.0",
            clientId: "client",
          }),
          protocol: "entra",
          issuer: "https://login.microsoftonline.com/test/v2.0",
          clientId: "client",
          displayName: "Work",
          capabilities: [],
        },
        redirectUri: "https://vault.example/",
        generation: 1,
        nonce: "n",
      },
      fetch,
    ),
  ).rejects.toThrow("authenticate again");
  expect(sdk).not.toHaveBeenCalled();
});
