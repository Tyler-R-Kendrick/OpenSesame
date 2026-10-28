import { exportPKCS8, generateKeyPair } from "jose";
import { expect, it } from "vitest";
import { subscribeDeviceRows } from "./device-connector-records.js";
import { requireNativeOAuthRecord } from "./native-oauth-session.js";
import { readNativeOriginPrivateKey } from "./native-origin-configuration.js";
import { originFixture } from "./native-origin.test-support.js";
import { readVaultCredentialsForWithdrawal } from "./vault-credential-custody.js";

it("preserves a published Origin replacement when a committed-row listener throws", async () => {
  const f = await originFixture();
  try {
    const first = await f.driver.configure(f.input);
    const previous = requireNativeOAuthRecord(first.connectionId).privateState
      .credentials.origin_app_reference;
    const replacement = await generateKeyPair("Ed25519", {
      extractable: true,
    });
    const privateKey = await exportPKCS8(replacement.privateKey);
    const stop = subscribeDeviceRows(() => {
      throw new Error("Injected post-publication listener failure");
    });
    try {
      await expect(
        f.driver.configure({
          ...f.input,
          connectionId: first.connectionId,
          revision: first.revision,
          credentials: { private_key: privateKey },
        }),
      ).rejects.toThrow("Injected post-publication listener failure");
    } finally {
      stop();
    }
    expect(readNativeOriginPrivateKey(first.connectionId, f.owner)).toBe(
      privateKey,
    );
    const recovery = requireNativeOAuthRecord(first.connectionId).privateState
      .recovery;
    expect(recovery).toHaveLength(1);
    expect(recovery[0]?.credentials?.phase).toBe("superseded");
    expect(
      readVaultCredentialsForWithdrawal(
        previous ?? "",
        first.configuration.fingerprint,
        ["appPrivateKey"],
        f.owner.tomb,
      ),
    ).not.toBeNull();
  } finally {
    await f.close();
  }
});
