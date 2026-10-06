import { z } from "zod";
import { type VaultMetadata, parseServiceToken } from "./auth.js";
import { passwordAgentPolicy as policy } from "./policy.js";
import type { SetupOptions } from "./service-account.js";
import { type PasswordAgentPort, json, records, string } from "./transport.js";
const vaultMetadata = z.array(
  z.object({ id: z.string().regex(/^[a-z0-9]{26}$/), name: z.string() }),
);
const builtIn = new Set(policy.dedicatedVaultDeniedNames);

function validate(options: SetupOptions) {
  const name = options.name.trim();
  const vaultName = options.vault.trim();
  const saveVault = options.saveVault.trim();
  if (
    !name ||
    !vaultName ||
    !saveVault ||
    /[\r\n]/.test(name + vaultName + saveVault) ||
    name.startsWith("-") ||
    vaultName.startsWith("-")
  )
    throw new Error(
      "An account name, dedicated vault and backup vault are required.",
    );
  if (builtIn.has(vaultName.toLowerCase()))
    throw new Error("Choose a dedicated automation vault.");
  if (
    options.expiresIn !== undefined &&
    !/^[1-9]\d*[smhdw]$/.test(options.expiresIn)
  )
    throw new Error("Expiry must be a positive duration such as 90d.");
  return { name, vaultName, saveVault };
}
async function automationVault(
  admin: PasswordAgentPort,
  options: SetupOptions,
  vaults: readonly VaultMetadata[],
  backup: VaultMetadata,
) {
  const vaultName = options.vault.trim();
  const scope =
    options.account === undefined ? {} : { account: options.account };
  const select = (value: string) =>
    vaults.filter((vault) => vault.id === value || vault.name === value);
  const selected = select(vaultName);
  if (selected.length > 1) throw new Error("Automation vault is ambiguous.");
  let vault = selected[0];
  if (!vault) {
    if (!options.createVault)
      throw new Error("Automation vault does not exist; use --create-vault.");
    const created = await json(
      admin,
      ["vault", "create", vaultName, "--format", "json"],
      scope,
      "Vault creation is unverified; inspect before retrying.",
    );
    vault = vaultMetadata.parse([created])[0];
    if (!vault || vault.name !== vaultName)
      throw new Error("Vault creation is unverified; inspect before retrying.");
  }
  if (builtIn.has(vault.name.toLowerCase()) || vault.id === backup.id)
    throw new Error("Automation and backup vaults must be separate.");
  return vault;
}
export async function prepareSetup(
  admin: PasswordAgentPort,
  options: SetupOptions,
) {
  const { name, saveVault } = validate(options);
  const scope =
    options.account === undefined ? {} : { account: options.account };
  const vaults = vaultMetadata.parse(
    await json(admin, ["vault", "list", "--format", "json"], scope),
  );
  const select = (value: string) =>
    vaults.filter((vault) => vault.id === value || vault.name === value);
  const backups = select(saveVault);
  const backup = backups[0];
  if (backups.length !== 1 || !backup)
    throw new Error(
      "Backup vault must resolve to one existing vault; nothing was created.",
    );
  const title = `1Password ${name} Service Account Token`;
  const items = records(
    await json(
      admin,
      ["item", "list", "--vault", backup.id, "--format", "json"],
      scope,
    ),
  );
  if (
    items.some(
      (item) => string(item.title).trim().toLowerCase() === title.toLowerCase(),
    )
  )
    throw new Error("A token backup already exists; nothing was created.");
  const vault = await automationVault(admin, options, vaults, backup);
  return { name, scope, vault, backup, title };
}
export async function createServiceAccount(
  admin: PasswordAgentPort,
  options: SetupOptions,
  vault: VaultMetadata,
  name: string,
) {
  const scope =
    options.account === undefined ? {} : { account: options.account };
  try {
    return parseServiceToken(
      await admin.invoke(
        [
          "service-account",
          "create",
          name,
          "--vault",
          `${vault.id}:read_items${options.write ? ",write_items" : ""}`,
          "--raw",
          ...(options.expiresIn ? ["--expires-in", options.expiresIn] : []),
        ],
        scope,
      ),
    );
  } catch {
    throw new Error(
      "Service-account creation is unverified; do not retry setup.",
    );
  }
}
