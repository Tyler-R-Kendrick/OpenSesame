/** Origin-scoped passwords, with no OS-keychain enumeration or browser deletion claim. */
import { createSecretBackendSessions } from "./sessions.js";
import {
  type SecretBackend,
  SecretBackendError,
  type SecretBackendItem,
  type SecretBackendItemInput,
  type SecretBackendSession,
} from "./types.js";

export type BrowserPasswordCredential = {
  id: string;
  password: string;
  name: string;
};
export type CredentialManagementPort = {
  origin(): string;
  secureContext(): boolean;
  supported(): boolean;
  getPassword(): Promise<BrowserPasswordCredential | null>;
  storePassword(credential: BrowserPasswordCredential): Promise<void>;
  preventSilentAccess(): Promise<void>;
};
type PasswordSession = {
  origin: string;
  credential: BrowserPasswordCredential | null;
  revision: number;
};

function passwordView(value: BrowserPasswordCredential): SecretBackendItem {
  return {
    id: value.id,
    name: value.name || value.id,
    kind: "login",
    username: value.id,
    notes: "",
    secret: value.password,
  };
}
function passwordInput(
  input: SecretBackendItemInput,
): BrowserPasswordCredential {
  const id = input.username?.trim() || input.name.trim();
  if (!id || !input.secret)
    throw new SecretBackendError(
      "configuration",
      "Enter an account identifier and password.",
    );
  if (input.notes || Object.keys(input.fields ?? {}).length || input.url)
    throw new SecretBackendError(
      "unsupported",
      "Browser password credentials cannot keep notes, custom fields, or other-site URLs.",
    );
  if (input.kind && input.kind !== "login")
    throw new SecretBackendError(
      "unsupported",
      "The browser stores password credentials only.",
    );
  return { id, password: input.secret, name: input.name };
}

export function createCredentialManagementBackend(
  port?: CredentialManagementPort,
): SecretBackend {
  return new CredentialManagementBackend(port);
}
class CredentialManagementBackend implements SecretBackend {
  readonly id = "credential-management";
  readonly name = "Browser passwords for this origin";
  readonly capabilities = {
    list: false,
    get: true,
    create: true,
    update: true,
    delete: false,
    import: false,
    itemKinds: ["login"] as const,
    itemFields: ["username", "secret"] as const,
  };
  readonly #sessions = createSecretBackendSessions<PasswordSession>(this.id);
  #port: CredentialManagementPort | undefined;
  constructor(port?: CredentialManagementPort) {
    this.#port = port;
  }
  #live(): CredentialManagementPort {
    if (!this.#port)
      throw new SecretBackendError(
        "authentication",
        "Connect the browser credential backend first.",
      );
    return this.#port;
  }
  #available(): void {
    if (!this.#live().secureContext() || !this.#live().supported())
      throw new SecretBackendError(
        "unsupported",
        "This browser does not provide password Credential Management in this secure context.",
      );
  }
  #state(session: SecretBackendSession): PasswordSession {
    this.#available();
    const held = this.#sessions.read(session);
    if (held.origin !== this.#live().origin())
      throw new SecretBackendError(
        "stale",
        "The page origin changed. Connect again.",
      );
    return held;
  }
  #selected(
    reference: string,
    session: SecretBackendSession,
  ): BrowserPasswordCredential {
    const value = this.#state(session).credential;
    if (!value || (reference !== value.id && reference !== value.name))
      throw new SecretBackendError(
        "not-found",
        "No matching browser password is selected. Select or create one for this origin.",
      );
    return value;
  }
  async authenticate() {
    this.#port ??= (
      await import("../../browser/secret-backend-credentials.js")
    ).browserCredentialManagementPort();
    this.#available();
    const origin = this.#live().origin();
    const credential = await this.#live().getPassword();
    this.#available();
    if (origin !== this.#live().origin())
      throw new SecretBackendError(
        "stale",
        "The page origin changed during the password prompt.",
      );
    return this.#sessions.create({ origin, credential, revision: 0 });
  }
  async listItems(): Promise<never> {
    throw new SecretBackendError(
      "unsupported",
      "The browser does not enumerate saved passwords.",
    );
  }
  async getItem(reference: string, session: SecretBackendSession) {
    return passwordView(this.#selected(reference, session));
  }
  async getNotes(reference: string, session: SecretBackendSession) {
    this.#selected(reference, session);
    return "";
  }
  async #store(
    input: SecretBackendItemInput,
    session: SecretBackendSession,
    expectedId?: string,
  ) {
    const held = this.#state(session);
    if (expectedId !== undefined && held.credential?.id !== expectedId)
      throw new SecretBackendError(
        "not-found",
        "That selected browser credential was not found.",
      );
    const value = passwordInput(input);
    if (expectedId !== undefined && value.id !== expectedId)
      throw new SecretBackendError(
        "unsupported",
        "Create a new browser credential to change its account identifier.",
      );
    const revision = held.revision;
    await this.#live().storePassword(value);
    this.#state(session);
    if (held.revision !== revision)
      throw new SecretBackendError(
        "stale",
        "Another browser credential was selected while this write was pending.",
      );
    held.credential = value;
    held.revision++;
    return passwordView(value);
  }
  async createItem(
    input: SecretBackendItemInput,
    session: SecretBackendSession,
  ) {
    return this.#store(input, session);
  }
  async updateItem(
    id: string,
    input: SecretBackendItemInput,
    session: SecretBackendSession,
  ) {
    return this.#store(input, session, id);
  }
  async disconnect(session: SecretBackendSession) {
    const held = this.#sessions.read(session);
    this.#sessions.remove(session);
    if (held.credential) held.credential.password = "";
    held.credential = null;
    // This only requires mediation next time; Credential Management has no delete API.
    if (held.origin === this.#live().origin() && this.#live().supported())
      await this.#live().preventSilentAccess();
  }
}
