import { z } from "zod";
import {
  type CredentialStore,
  type VaultMetadata,
  desktopEnvironment,
  parseServiceToken,
  protectedCredentialStore,
  requireEmpty,
  saveVerifiedToken,
  serviceEnvironment,
} from "./auth.js";
import { createApiCredential } from "./create.js";
import { createServiceAccount, prepareSetup } from "./service-setup.js";
import { type PasswordAgentPort, json } from "./transport.js";

export interface SetupOptions {
  name: string;
  vault: string;
  saveVault: string;
  account?: string;
  createVault: boolean;
  write: boolean;
  expiresIn?: string;
}
const vaultMetadata = z.array(
  z.object({ id: z.string().regex(/^[a-z0-9]{26}$/), name: z.string() }),
);
const manageUrl = "https://start.1password.com/developer-tools/active";

async function visibleVaults(
  port: PasswordAgentPort,
  token: string,
): Promise<VaultMetadata[]> {
  return vaultMetadata.parse(
    await json(port, ["vault", "list", "--format", "json"], {
      env: serviceEnvironment(token),
    }),
  );
}
function administrator(port: PasswordAgentPort): PasswordAgentPort {
  return {
    invoke: (args, options) =>
      port.invoke(args, { ...options, desktop: true, env: desktopEnvironment }),
  };
}
export async function setup(
  port: PasswordAgentPort,
  rawStore: CredentialStore,
  options: SetupOptions,
) {
  const store = protectedCredentialStore(rawStore);
  await requireEmpty(store);
  const admin = administrator(port);
  const { name, scope, vault, backup, title } = await prepareSetup(
    admin,
    options,
  );
  const token = await createServiceAccount(admin, options, vault, name);
  // Save a once-returned token before any later remote step can fail.
  await saveVerifiedToken(store, token);
  const settings = { name, vaults: [vault] };
  await store.saveSettings(settings);
  const visible = await visibleVaults(port, token);
  if (visible.length !== 1 || visible[0]?.id !== vault.id)
    throw new Error(
      "Account access did not match; token saved locally, do not repeat setup.",
    );
  let saved: { ref: string };
  try {
    saved = await createApiCredential(
      admin,
      { title, vault: backup.id, ...scope },
      token,
    );
  } catch {
    throw new Error(
      "Token saved locally, but backup is unverified; inspect backup, do not repeat setup.",
    );
  }
  await store.saveSettings({ ...settings, tokenRef: saved.ref });
  return {
    configured: true,
    name,
    vaults: visible,
    write: options.write,
    tokenRef: saved.ref,
    storage: store.storage,
    verified: true,
  };
}
export async function connect(
  port: PasswordAgentPort,
  rawStore: CredentialStore,
  input: string,
  name = "OpenSesame Automation",
) {
  const store = protectedCredentialStore(rawStore);
  if (!name.trim()) throw new Error("Account name is required.");
  await requireEmpty(store);
  const token = parseServiceToken(input);
  const vaults = await visibleVaults(port, token);
  await saveVerifiedToken(store, token);
  await store.saveSettings({ name: name.trim(), vaults });
  return {
    configured: true,
    name: name.trim(),
    vaults,
    storage: store.storage,
    verified: true,
  };
}
export async function status(
  port: PasswordAgentPort,
  rawStore: CredentialStore,
) {
  const store = protectedCredentialStore(rawStore);
  const saved = await store.loadSettings();
  if (!saved)
    return {
      configured: false,
      recoverable: await store.hasToken(),
      manageUrl,
    };
  const vaults = await visibleVaults(
    port,
    parseServiceToken(await store.loadToken()),
  );
  return {
    configured: true,
    ...saved,
    vaults,
    storage: store.storage,
    verified: true,
    manageUrl,
  };
}
export async function recover(
  port: PasswordAgentPort,
  rawStore: CredentialStore,
  name = "OpenSesame Automation",
) {
  const store = protectedCredentialStore(rawStore);
  if (!name.trim()) throw new Error("Account name is required.");
  const saved = await store.loadSettings();
  const vaults = await visibleVaults(
    port,
    parseServiceToken(await store.loadToken()),
  );
  const settings: import("./auth.js").ServiceSettings = {
    name: saved?.name ?? name.trim(),
    vaults,
  };
  if (saved?.tokenRef) settings.tokenRef = saved.tokenRef;
  await store.saveSettings(settings);
  return { configured: true, vaults, storage: store.storage, verified: true };
}
export async function forget(rawStore: CredentialStore) {
  const store = protectedCredentialStore(rawStore);
  await store.removeToken();
  if (await store.hasToken())
    throw new Error(
      "Local token removal is unverified; remote access was not revoked.",
    );
  await store.removeSettings();
  return { forgotten: true, remoteRevoked: false };
}
