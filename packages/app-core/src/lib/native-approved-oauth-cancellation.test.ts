/** Cancellation cannot activate observed grants, including the final durable close boundary. */
import { expect, it, vi } from "vitest";
import { kvSeams } from "./kv.js";
import {
  beginNativeBrowserAuthorization,
  configureNativeBrowserOAuthConnector,
  finishNativeBrowserAuthorization,
} from "./native-browser-oauth-connectors.js";
import {
  loadNativeConnectorRecord,
  readNativeConnector,
} from "./native-connector-store.js";
import { bindNativeOAuthBrowserPort } from "./native-oauth-browser-port.js";
import { NativeOAuthError } from "./native-oauth-errors.js";
import {
  gitlabAccount,
  installNativeOAuthTests,
  oauthAuthority,
  oauthCallback,
  oauthDraft,
  oauthToken,
} from "./native-oauth.test-support.js";
installNativeOAuthTests();
function latch() {
  let release: () => void = () => undefined;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { wait, release };
}
async function setup() {
  const provider = oauthAuthority();
  let cancelled = false;
  const dispose = bindNativeOAuthBrowserPort({
    redirectUri: "https://selfhost.example/auth/native-connector.html",
    navigate: provider.navigate,
    scrubCallback: provider.scrubCallback,
    captureAuthorizationGuard: () => () => {
      if (cancelled) throw new NativeOAuthError("denied");
    },
  });
  const draft = await configureNativeBrowserOAuthConnector(oauthDraft());
  await beginNativeBrowserAuthorization(draft.connectionId);
  return {
    provider,
    draft,
    dispose,
    cancel: () => {
      cancelled = true;
    },
  };
}
function assertRetained(id: string) {
  const record = loadNativeConnectorRecord(id);
  expect(record?.privateState.recovery[0]?.grant?.accessToken).toBe(
    "private-issued-access",
  );
  expect(record?.privateState.grants.user).toBeUndefined();
  expect(record?.privateState.verification).toBeNull();
  expect(record?.runtime.grants).toEqual([]);
  expect(readNativeConnector(id)?.status).toBe("cleanup");
}
it("retains a sent credential mutation's late token reply after Cancel and refuses resource verification", async () => {
  const s = await setup();
  const reached = latch();
  const resume = latch();
  s.provider.fetch.mockImplementation(async () => {
    reached.release();
    await resume.wait;
    return new Response(JSON.stringify(oauthToken()), { status: 200 });
  });
  try {
    const rejected = expect(
      finishNativeBrowserAuthorization(oauthCallback(s.draft.connectionId)),
    ).rejects.toThrow();
    await reached.wait;
    s.cancel();
    resume.release();
    await rejected;
    assertRetained(s.draft.connectionId);
    expect(s.provider.fetch).toHaveBeenCalledTimes(1);
  } finally {
    resume.release();
    s.dispose();
  }
});
it("refuses activation when Cancel occurs during the actual account API verification request", async () => {
  const s = await setup();
  const reached = latch();
  const resume = latch();
  let count = 0;
  s.provider.fetch.mockImplementation(async () => {
    count++;
    if (count === 1)
      return new Response(JSON.stringify(oauthToken()), { status: 200 });
    reached.release();
    await resume.wait;
    return new Response(JSON.stringify(gitlabAccount), { status: 200 });
  });
  try {
    const rejected = expect(
      finishNativeBrowserAuthorization(oauthCallback(s.draft.connectionId)),
    ).rejects.toThrow();
    await reached.wait;
    s.cancel();
    resume.release();
    await rejected;
    assertRetained(s.draft.connectionId);
  } finally {
    resume.release();
    s.dispose();
  }
});
it("aborts final activation before the guarded durable close and preserves the previously sealed recovery", async () => {
  const s = await setup();
  const reached = latch();
  const resume = latch();
  s.provider.replies.push({ body: oauthToken() }, { body: gitlabAccount });
  const durable = vi.mocked(kvSeams.kvSetDurable).getMockImplementation();
  if (!durable) throw new Error("Missing durable test seam");
  vi.mocked(kvSeams.kvSetDurable).mockImplementation(
    async (key, value, beforeCommit) => {
      if (beforeCommit) {
        reached.release();
        await resume.wait;
        beforeCommit();
      }
      await durable(key, value, beforeCommit);
    },
  );
  try {
    const rejected = expect(
      finishNativeBrowserAuthorization(oauthCallback(s.draft.connectionId)),
    ).rejects.toThrow();
    await reached.wait;
    s.cancel();
    resume.release();
    await rejected;
    assertRetained(s.draft.connectionId);
  } finally {
    resume.release();
    s.dispose();
  }
});
