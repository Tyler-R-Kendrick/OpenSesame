import { expect, it } from "vitest";
import { subscribeDeviceRows } from "./device-connector-records.js";
import {
  configureNativeOAuthClient,
  readNativeOAuthClientSecret,
} from "./native-oauth-client-config.js";
import { nativeOAuthClientFixture } from "./native-oauth-client.test-support.js";
import { requireNativeOAuthRecord } from "./native-oauth-session.js";
import { installNativeOAuthTests } from "./native-oauth.test-support.js";
import { readVaultCredentialsForWithdrawal } from "./vault-credential-custody.js";

installNativeOAuthTests();

it("preserves a published replacement when a committed-row listener throws", async () => {
  const f = await nativeOAuthClientFixture("client_secret_post");
  try {
    const first = await configureNativeOAuthClient(f.input, f.owner);
    const previous = requireNativeOAuthRecord(first.connectionId).privateState
      .credentials.oauth_client_reference;
    const stop = subscribeDeviceRows(() => {
      throw new Error("Injected post-publication listener failure");
    });
    let savedId = "";
    try {
      await expect(
        configureNativeOAuthClient(
          {
            ...f.input,
            parameters: {
              ...f.input.parameters,
              client_id: "replacement-client",
            },
            credentials: { client_secret: "replacement-client-secret" },
            connectionId: first.connectionId,
            revision: first.revision,
          },
          f.owner,
        ),
      ).rejects.toThrow("Injected post-publication listener failure");
      savedId = first.connectionId;
    } finally {
      stop();
    }
    expect(readNativeOAuthClientSecret(savedId, f.owner)).toBe(
      "replacement-client-secret",
    );
    const recovery = requireNativeOAuthRecord(savedId).privateState.recovery;
    expect(recovery).toHaveLength(1);
    expect(recovery[0]?.credentials?.phase).toBe("superseded");
    expect(
      readVaultCredentialsForWithdrawal(
        previous ?? "",
        first.configuration.fingerprint,
        ["clientSecret"],
        f.owner.tomb,
      ),
    ).not.toBeNull();
  } finally {
    await f.close();
  }
});
