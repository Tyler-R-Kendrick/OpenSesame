import type { PasswordAgentPort } from "./transport.js";

export interface VaultMetadata {
  id: string;
  name: string;
}
export interface ServiceSettings {
  name: string;
  vaults: readonly VaultMetadata[];
  tokenRef?: string;
}
/** Secret storage is a host port; the core never selects a plaintext fallback. */
export interface CredentialStore {
  readonly storage: string;
  hasToken(): Promise<boolean>;
  loadToken(): Promise<string>;
  saveToken(token: string): Promise<void>;
  removeToken(): Promise<void>;
  loadSettings(): Promise<ServiceSettings | undefined>;
  saveSettings(settings: ServiceSettings): Promise<void>;
  removeSettings(): Promise<void>;
}
export function serviceEnvironment(token: string) {
  return {
    OP_SERVICE_ACCOUNT_TOKEN: token,
    OP_ACCOUNT: undefined,
    OP_CONNECT_HOST: undefined,
    OP_CONNECT_TOKEN: undefined,
  };
}
export const desktopEnvironment = {
  OP_SERVICE_ACCOUNT_TOKEN: undefined,
  OP_CONNECT_HOST: undefined,
  OP_CONNECT_TOKEN: undefined,
};
export function parseServiceToken(raw: string): string {
  const token = raw.replace(/\r?\n$/, "");
  if (!/^ops_[^\s]+$/.test(token))
    throw new Error("Invalid service-account token; details suppressed.");
  return token;
}
export function authenticatedPort(
  port: PasswordAgentPort,
  store: CredentialStore,
  supplied?: string,
  desktop = false,
): PasswordAgentPort {
  let selected: Promise<Record<string, string | undefined>> | undefined;
  const environment = () => {
    if (selected) return selected;
    selected = (async () => {
      if (desktop) return desktopEnvironment;
      if (supplied !== undefined)
        return serviceEnvironment(parseServiceToken(supplied));
      const settings = await store.loadSettings();
      // An orphaned token must also fail closed rather than widen to desktop.
      if (settings || (await store.hasToken()))
        return serviceEnvironment(parseServiceToken(await store.loadToken()));
      return {};
    })().catch(() => {
      throw new Error(
        "Could not resolve service-account authentication; desktop authentication was not attempted.",
      );
    });
    return selected;
  };
  const result: PasswordAgentPort = {
    invoke: async (args, options = {}) => {
      const auth = options.desktop ? desktopEnvironment : await environment();
      return port.invoke(args, {
        ...options,
        env: { ...auth, ...options.env },
      });
    },
  };
  const run = port.run;
  if (run)
    result.run = async (args, command, env, options = {}) => {
      const auth = options.desktop ? desktopEnvironment : await environment();
      return run(args, command, env, {
        ...options,
        env: { ...auth, ...options.env },
      });
    };
  const runEnvFile = port.runEnvFile;
  if (runEnvFile)
    result.runEnvFile = async (content, command, options = {}) => {
      const auth = options.desktop ? desktopEnvironment : await environment();
      return runEnvFile(content, command, {
        ...options,
        env: { ...auth, ...options.env },
      });
    };
  const readMany = port.readMany;
  if (readMany)
    result.readMany = async (references, options = {}) => {
      const auth = options.desktop ? desktopEnvironment : await environment();
      return readMany(references, {
        ...options,
        env: { ...auth, ...options.env },
      });
    };
  return result;
}
export async function requireEmpty(store: CredentialStore): Promise<void> {
  if ((await store.loadSettings()) || (await store.hasToken()))
    throw new Error(
      "A saved account exists; use status, recover or forget first.",
    );
}
export async function saveVerifiedToken(
  store: CredentialStore,
  token: string,
): Promise<void> {
  try {
    await store.saveToken(token);
    if ((await store.loadToken()) !== token) throw new Error("mismatch");
  } catch {
    throw new Error(
      "Token storage is unverified; account creation must not be retried.",
    );
  }
}

async function storageOperation<T>(action: () => Promise<T>): Promise<T> {
  try {
    return await action();
  } catch {
    throw new Error(
      "Local service-account storage is unverified; recover saved access before retrying setup (details suppressed).",
    );
  }
}
/** A host storage failure may contain a value; none crosses the core boundary. */
export function protectedCredentialStore(
  store: CredentialStore,
): CredentialStore {
  return {
    storage: store.storage,
    hasToken: () => storageOperation(() => store.hasToken()),
    loadToken: () => storageOperation(() => store.loadToken()),
    saveToken: (value) => storageOperation(() => store.saveToken(value)),
    removeToken: () => storageOperation(() => store.removeToken()),
    loadSettings: () => storageOperation(() => store.loadSettings()),
    saveSettings: (value) => storageOperation(() => store.saveSettings(value)),
    removeSettings: () => storageOperation(() => store.removeSettings()),
  };
}
