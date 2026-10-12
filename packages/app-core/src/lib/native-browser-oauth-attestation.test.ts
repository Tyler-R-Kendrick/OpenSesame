import { expect, it, vi } from "vitest";
import {
  attestNativeBrowserOAuthRevocation,
  nativeBrowserOAuthRevocationInstructions,
} from "./native-browser-oauth-attestation.js";
import {
  beginNativeBrowserAuthorization,
  configureNativeBrowserOAuthConnector,
  finishNativeBrowserAuthorization,
} from "./native-browser-oauth-connectors.js";
import { browserOAuthClassification } from "./native-browser-oauth-profile.js";
import {
  loadNativeConnectorRecord,
  readNativeConnector,
  updateNativeConnector,
} from "./native-connector-store.js";
import { nativeOAuthGuard } from "./native-oauth-session.js";
import {
  gitlabAccount,
  installNativeOAuthTests,
  oauthAuthority,
  oauthCallback,
  oauthDraft,
  oauthToken,
} from "./native-oauth.test-support.js";

installNativeOAuthTests();
it("cannot activate a rotated recovery credential using proof from the prior token", async () => {
  const provider = oauthAuthority();
  const draft = await configureNativeBrowserOAuthConnector(oauthDraft());
  await beginNativeBrowserAuthorization(draft.connectionId);
  provider.fetch.mockImplementationOnce(
    async () => new Response(JSON.stringify(oauthToken())),
  );
  provider.fetch.mockImplementationOnce(async () => {
    const current = loadNativeConnectorRecord(draft.connectionId);
    if (!current) throw new Error("Expected native connection");
    await updateNativeConnector(
      draft.connectionId,
      nativeOAuthGuard(current),
      browserOAuthClassification(current.configuration),
      (record) => {
        const grant = record.privateState.recovery[0]?.grant;
        if (!grant)
          throw new Error("Expected retained grant before verification");
        grant.accessToken = "foreign-rotated-access";
        grant.refreshToken = "foreign-rotated-refresh";
        grant.scopes = ["read_user", "read_api"];
        return record;
      },
    );
    return new Response(JSON.stringify(gitlabAccount));
  });
  provider.replies.push({ body: null, status: 503 });
  await expect(
    finishNativeBrowserAuthorization(oauthCallback(draft.connectionId)),
  ).rejects.toThrow("connector changed");
  expect(readNativeConnector(draft.connectionId)?.status).toBe("cleanup");
  expect(
    loadNativeConnectorRecord(draft.connectionId)?.privateState.recovery[0]
      ?.grant?.refreshToken,
  ).toBe("foreign-rotated-refresh");
  expect(
    loadNativeConnectorRecord(draft.connectionId)?.privateState.grants,
  ).toEqual({});
});
it("resolves an indeterminate exchange only after explicit provider-revocation confirmation, without claiming verified success", async () => {
  const provider = oauthAuthority();
  const draft = await configureNativeBrowserOAuthConnector(oauthDraft());
  await beginNativeBrowserAuthorization(draft.connectionId);
  provider.replies.push({ body: null, status: 503 });
  await expect(
    finishNativeBrowserAuthorization(oauthCallback(draft.connectionId)),
  ).rejects.toThrow();
  const recoveryId = readNativeConnector(draft.connectionId)?.recovery[0]?.id;
  if (!recoveryId) throw new Error("Expected exchange obligation");
  expect(
    nativeBrowserOAuthRevocationInstructions(draft.connectionId, recoveryId),
  ).toMatchObject({
    url: "https://gitlab.com/-/user_settings/applications",
    canConfirm: false,
  });
  await expect(
    attestNativeBrowserOAuthRevocation(draft.connectionId, recoveryId),
  ).rejects.toThrow("cleanup");
  vi.useFakeTimers();
  vi.setSystemTime(Date.now() + 61_000);
  expect(
    nativeBrowserOAuthRevocationInstructions(draft.connectionId, recoveryId)
      .canConfirm,
  ).toBe(true);
  const view = await attestNativeBrowserOAuthRevocation(
    draft.connectionId,
    recoveryId,
  );
  expect(view.status).toBe("configuration");
  expect(view.identity).toBeNull();
  expect(view.verifiedAt).toBeNull();
  expect(view.recovery).toEqual([]);
  await beginNativeBrowserAuthorization(draft.connectionId);
  expect(readNativeConnector(draft.connectionId)?.status).toBe("authorizing");
});
it("refuses explicitly deselected account verification permissions instead of adding privileges", async () => {
  oauthAuthority();
  const input = oauthDraft();
  input.requestedScopes.user = [];
  await expect(configureNativeBrowserOAuthConnector(input)).rejects.toThrow(
    "permissions selected",
  );
});
