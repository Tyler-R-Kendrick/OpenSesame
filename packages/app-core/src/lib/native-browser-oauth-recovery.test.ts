import { expect, it, vi } from "vitest";
import { kvSeams } from "./kv.js";
import {
  beginNativeBrowserAuthorization,
  configureNativeBrowserOAuthConnector,
  finishNativeBrowserAuthorization,
  invokeNativeBrowserOAuthConnector,
  verifyNativeBrowserOAuthConnector,
} from "./native-browser-oauth-connectors.js";
import { retryNativeConnectorCleanup } from "./native-connector-lifecycle.js";
import {
  loadNativeConnectorRecord,
  readNativeConnector,
} from "./native-connector-store.js";
import {
  gitlabAccount,
  installNativeOAuthTests,
  oauthAuthority,
  oauthCallback,
  oauthDraft,
  oauthToken,
} from "./native-oauth.test-support.js";

installNativeOAuthTests();
it("retains an already-issued late credential after capability disposal and never activates it", async () => {
  const provider = oauthAuthority();
  const draft = await configureNativeBrowserOAuthConnector(oauthDraft());
  await beginNativeBrowserAuthorization(draft.connectionId);
  provider.transport.settleCredentialMutation = async () => {
    provider.assertCurrent.mockImplementation(() => {
      throw new Error("Captured lease expired");
    });
    return new Response(JSON.stringify(oauthToken()), { status: 200 });
  };
  await expect(
    finishNativeBrowserAuthorization(oauthCallback(draft.connectionId)),
  ).rejects.toThrow("lease expired");
  const record = loadNativeConnectorRecord(draft.connectionId);
  expect(record?.privateState.grants).toEqual({});
  expect(record?.privateState.recovery[0]?.grant?.refreshToken).toBe(
    "private-issued-refresh",
  );
  expect(readNativeConnector(draft.connectionId)?.status).toBe("cleanup");
  expect(provider.fetch).not.toHaveBeenCalled();
  provider.assertCurrent.mockImplementation(() => undefined);
  provider.replies.push({ body: null }, { body: null });
  expect((await retryNativeConnectorCleanup(draft.connectionId)).status).toBe(
    "configuration",
  );
});
it("seals an issued pair from its private retained journal before retrying provider cleanup after disk failure", async () => {
  const provider = oauthAuthority();
  const draft = await configureNativeBrowserOAuthConnector(oauthDraft());
  await beginNativeBrowserAuthorization(draft.connectionId);
  const write = vi.spyOn(kvSeams, "kvSetDurable");
  const original = write.getMockImplementation();
  if (!original) throw new Error("Expected persistent test storage");
  let failing = true;
  write.mockImplementation(async (key, value) => {
    if (failing && provider.fetch.mock.calls.length > 0)
      throw new Error("Disk unavailable");
    await original(key, value);
  });
  provider.replies.push({ body: oauthToken() }, { body: null, status: 503 });
  await expect(
    finishNativeBrowserAuthorization(oauthCallback(draft.connectionId)),
  ).rejects.toThrow("cleanup");
  expect(
    loadNativeConnectorRecord(draft.connectionId)?.privateState.recovery[0]
      ?.grant,
  ).toBeUndefined();
  expect(readNativeConnector(draft.connectionId)?.status).toBe("cleanup");
  failing = false;
  provider.replies.push({ body: null }, { body: null });
  expect((await retryNativeConnectorCleanup(draft.connectionId)).status).toBe(
    "configuration",
  );
  const revocation = new URLSearchParams(
    String(provider.fetch.mock.calls[2]?.[1]?.body),
  );
  expect(revocation.get("token")).toBe("private-issued-refresh");
  expect(
    loadNativeConnectorRecord(draft.connectionId)?.privateState.recovery,
  ).toEqual([]);
});
it("refreshes an expired public GitLab grant and retains its actual prior permissions when refresh omits scope", async () => {
  const provider = oauthAuthority();
  const draft = await configureNativeBrowserOAuthConnector(oauthDraft());
  await beginNativeBrowserAuthorization(draft.connectionId);
  provider.replies.push(
    { body: { ...oauthToken(), expires_in: 1 } },
    { body: gitlabAccount },
  );
  await finishNativeBrowserAuthorization(oauthCallback(draft.connectionId));
  vi.useFakeTimers();
  vi.setSystemTime(Date.now() + 2000);
  provider.replies.push(
    {
      body: {
        access_token: "rotated-private-access",
        refresh_token: "rotated-private-refresh",
        token_type: "Bearer",
        expires_in: 3600,
      },
    },
    { body: gitlabAccount },
    { body: gitlabAccount },
  );
  expect(
    await invokeNativeBrowserOAuthConnector(
      draft.connectionId,
      "provider.read",
    ),
  ).toEqual({ label: "Verified GitLab user", items: [] });
  const form = new URLSearchParams(
    String(provider.fetch.mock.calls[2]?.[1]?.body),
  );
  expect(form.get("grant_type")).toBe("refresh_token");
  expect(form.get("refresh_token")).toBe("private-issued-refresh");
  const saved = loadNativeConnectorRecord(draft.connectionId);
  expect(saved?.privateState.grants.user?.refreshToken).toBe(
    "rotated-private-refresh",
  );
  expect(saved?.privateState.grants.user?.scopes).toEqual(["read_user"]);
  expect(saved?.privateState.recovery).toEqual([]);
  expect(readNativeConnector(draft.connectionId)?.status).toBe("connected");
});
it("clears ready state when a previously verified provider refuses the actual saved grant", async () => {
  const provider = oauthAuthority();
  const draft = await configureNativeBrowserOAuthConnector(oauthDraft());
  await beginNativeBrowserAuthorization(draft.connectionId);
  provider.replies.push({ body: oauthToken() }, { body: gitlabAccount });
  await finishNativeBrowserAuthorization(oauthCallback(draft.connectionId));
  provider.replies.push({ body: { error: "private-body" }, status: 401 });
  await expect(
    verifyNativeBrowserOAuthConnector(draft.connectionId),
  ).rejects.toThrow("expired");
  expect(readNativeConnector(draft.connectionId)?.status).toBe("reauthorize");
  expect(readNativeConnector(draft.connectionId)?.verifiedAt).toBeNull();
  expect(
    loadNativeConnectorRecord(draft.connectionId)?.privateState.grants.user
      ?.accessToken,
  ).toBe("private-issued-access");
});
