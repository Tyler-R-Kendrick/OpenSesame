import { expect, it } from "vitest";
import { cancelNativeBrowserConsent } from "./native-browser-oauth-cancel.js";
import {
  beginNativeBrowserAuthorization,
  configureNativeBrowserOAuthConnector,
} from "./native-browser-oauth-connectors.js";
import { loadNativeConnectorRecord } from "./native-connector-store.js";
import { bindNativeOAuthBrowserPort } from "./native-oauth-browser-port.js";
import {
  installNativeOAuthTests,
  oauthAuthority,
  oauthDraft,
  oauthPending,
} from "./native-oauth.test-support.js";
installNativeOAuthTests();
it("removes only the matching unexchanged consent and leaves another state intact", async () => {
  oauthAuthority();
  const draft = await configureNativeBrowserOAuthConnector(oauthDraft());
  await beginNativeBrowserAuthorization(draft.connectionId);
  const state = oauthPending(draft.connectionId).state;
  await cancelNativeBrowserConsent(
    draft.connectionId,
    "another-unrelated-state",
  );
  expect(oauthPending(draft.connectionId).state).toBe(state);
  await cancelNativeBrowserConsent(draft.connectionId, state);
  expect(
    loadNativeConnectorRecord(draft.connectionId)?.privateState.pending,
  ).toEqual({});
  expect(
    loadNativeConnectorRecord(draft.connectionId)?.privateState.recovery,
  ).toEqual([]);
});
it("does not clear a newer consent started after the dismissed window", async () => {
  oauthAuthority();
  const draft = await configureNativeBrowserOAuthConnector(oauthDraft());
  await beginNativeBrowserAuthorization(draft.connectionId);
  const old = oauthPending(draft.connectionId).state;
  await beginNativeBrowserAuthorization(draft.connectionId);
  const current = oauthPending(draft.connectionId).state;
  await cancelNativeBrowserConsent(draft.connectionId, old);
  expect(oauthPending(draft.connectionId).state).toBe(current);
});
it("clears a popup failure's pending transaction without clearing issued-grant recovery", async () => {
  const provider = oauthAuthority();
  const draft = await configureNativeBrowserOAuthConnector(oauthDraft());
  const dispose = bindNativeOAuthBrowserPort({
    redirectUri: "https://selfhost.example/auth/native-connector.html",
    navigate: provider.navigate,
    scrubCallback: provider.scrubCallback,
    authorize: async () => {
      throw new Error("Popup dismissed");
    },
  });
  try {
    await expect(
      beginNativeBrowserAuthorization(draft.connectionId),
    ).rejects.toThrow("dismissed");
    expect(
      loadNativeConnectorRecord(draft.connectionId)?.privateState.pending,
    ).toEqual({});
    expect(
      loadNativeConnectorRecord(draft.connectionId)?.privateState.recovery,
    ).toEqual([]);
  } finally {
    dispose();
  }
});
