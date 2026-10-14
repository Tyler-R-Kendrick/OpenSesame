/** Browser-only W3C Credential Management boundary. It cannot read an OS keychain. */
import type {
  BrowserPasswordCredential,
  CredentialManagementPort,
} from "../lib/secret-backends/credential-management.js";
import { SecretBackendError } from "../lib/secret-backends/types.js";

interface NativePasswordCredential extends Credential {
  readonly password: string;
  readonly name: string;
}
interface PasswordCredentialConstructor {
  new (value: BrowserPasswordCredential): NativePasswordCredential;
}
declare global {
  var PasswordCredential: PasswordCredentialConstructor | undefined;
}
interface PasswordRequest extends CredentialRequestOptions {
  password: true;
}

export function browserCredentialManagementPort(): CredentialManagementPort {
  const passwordConstructor = () => {
    const api = globalThis.PasswordCredential;
    if (!api)
      throw new SecretBackendError(
        "unsupported",
        "Password Credential Management is unavailable.",
      );
    return api;
  };
  return {
    origin: () => globalThis.location.origin,
    secureContext: () => globalThis.isSecureContext === true,
    supported: () =>
      Boolean(
        globalThis.PasswordCredential &&
          globalThis.navigator?.credentials?.store,
      ),
    async getPassword() {
      const api = passwordConstructor();
      const options: PasswordRequest = {
        password: true,
        mediation: "required",
      };
      const value = await navigator.credentials.get(options);
      if (value === null) return null;
      if (!(value instanceof api))
        throw new SecretBackendError(
          "response",
          "The browser did not return a password credential.",
        );
      return { id: value.id, password: value.password, name: value.name };
    },
    async storePassword(value) {
      await navigator.credentials.store(new (passwordConstructor())(value));
    },
    async preventSilentAccess() {
      await navigator.credentials.preventSilentAccess();
    },
  };
}
