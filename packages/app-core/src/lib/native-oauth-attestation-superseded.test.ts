import { exportPKCS8, generateKeyPair } from "jose";
import { expect, it } from "vitest";
import {
  attestNativeBrowserOAuthRevocation,
  nativeBrowserOAuthRevocationInstructions,
} from "./native-browser-oauth-attestation.js";
import { configureNativeOAuthClient } from "./native-oauth-client-config.js";
import { nativeOAuthClientFixture } from "./native-oauth-client.test-support.js";
import { requireNativeOAuthRecord } from "./native-oauth-session.js";
import { installNativeOAuthTests } from "./native-oauth.test-support.js";
import { originFixture } from "./native-origin.test-support.js";
import { readVaultCredentialsForWithdrawal } from "./vault-credential-custody.js";

installNativeOAuthTests();

function recovery(id: string) {
  const entry = requireNativeOAuthRecord(id).privateState.recovery[0];
  if (!entry) throw new Error("Expected a superseded-credential obligation");
  return entry;
}

it("does not let manual attestation orphan a superseded OAuth client secret", async () => {
  const f = await nativeOAuthClientFixture("client_secret_post");
  try {
    const first = await configureNativeOAuthClient(f.input, f.owner);
    const saved = await configureNativeOAuthClient(
      {
        ...f.input,
        parameters: { ...f.input.parameters, client_id: "replacement-client" },
        credentials: { client_secret: "replacement-client-secret" },
        connectionId: first.connectionId,
        revision: first.revision,
      },
      f.owner,
    );
    const entry = recovery(saved.connectionId);
    expect(entry.credentials?.phase).toBe("superseded");
    expect(
      nativeBrowserOAuthRevocationInstructions(saved.connectionId, entry.id)
        .canConfirm,
    ).toBe(false);
    await expect(
      attestNativeBrowserOAuthRevocation(saved.connectionId, entry.id),
    ).rejects.toThrow("cleanup");
    expect(recovery(saved.connectionId).id).toBe(entry.id);
    expect(
      readVaultCredentialsForWithdrawal(
        entry.credentials?.oauth_client_reference ?? "",
        entry.fingerprint,
        ["clientSecret"],
        f.owner.tomb,
      ),
    ).not.toBeNull();
  } finally {
    await f.close();
  }
});

it("does not let manual attestation orphan a superseded Origin private key", async () => {
  const f = await originFixture();
  try {
    const first = await f.driver.configure(f.input);
    const replacement = await generateKeyPair("Ed25519", {
      extractable: true,
    });
    const saved = await f.driver.configure({
      ...f.input,
      connectionId: first.connectionId,
      revision: first.revision,
      credentials: { private_key: await exportPKCS8(replacement.privateKey) },
    });
    const entry = recovery(saved.connectionId);
    expect(entry.credentials?.phase).toBe("superseded");
    expect(
      nativeBrowserOAuthRevocationInstructions(saved.connectionId, entry.id)
        .canConfirm,
    ).toBe(false);
    await expect(
      attestNativeBrowserOAuthRevocation(saved.connectionId, entry.id),
    ).rejects.toThrow("cleanup");
    expect(recovery(saved.connectionId).id).toBe(entry.id);
    expect(
      readVaultCredentialsForWithdrawal(
        entry.credentials?.origin_app_reference ?? "",
        entry.fingerprint,
        ["appPrivateKey"],
        f.owner.tomb,
      ),
    ).not.toBeNull();
  } finally {
    await f.close();
  }
});
