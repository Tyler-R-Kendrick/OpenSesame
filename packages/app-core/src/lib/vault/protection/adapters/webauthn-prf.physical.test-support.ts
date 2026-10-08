import { overlapCast } from "@opensesame/os-domain";
import { randomBytes } from "@opensesame/vault-core";
import { vi } from "vitest";
import type { AuthenticatorPort } from "../../../../ports.js";

/** Only the hardware/browser I/O is doubled; all ceremony validation is real. */
export class PhysicalCredential implements Credential {
  readonly type = "public-key";
  readonly id = "physical-fixture";
  readonly response: { clientDataJSON: ArrayBuffer };

  constructor(
    readonly rawId: ArrayBuffer,
    readonly extensions: AuthenticationExtensionsClientOutputs,
    ceremonyType = "webauthn.create",
    origin = "http://localhost",
    rpId = "localhost",
  ) {
    this.response = {
      clientDataJSON: new TextEncoder().encode(
        JSON.stringify({ type: ceremonyType, origin, rpId }),
      ).buffer,
    };
  }

  getClientExtensionResults(): AuthenticationExtensionsClientOutputs {
    return this.extensions;
  }

  static async getClientCapabilities(): Promise<Record<string, boolean>> {
    return { "extension:prf": true };
  }
}

export function physicalAuthenticator() {
  const credentialId = new Uint8Array(randomBytes(16)).buffer;
  const output = new Uint8Array(randomBytes(32)).buffer;
  function credential(
    ceremonyType = "webauthn.create",
    first = output.slice(0),
  ) {
    return new PhysicalCredential(
      credentialId,
      overlapCast({ prf: { results: { first } } }),
      ceremonyType,
    );
  }
  const create = vi.fn(
    async (_options?: CredentialCreationOptions): Promise<Credential | null> =>
      credential(),
  );
  const get = vi.fn(
    async (_options?: CredentialRequestOptions): Promise<Credential | null> =>
      credential("webauthn.get"),
  );
  const port: AuthenticatorPort = {
    credentials: { create, get },
    publicKeyCredential: overlapCast(PhysicalCredential),
  };
  return { port, create, get, credential, credentialId, output };
}
