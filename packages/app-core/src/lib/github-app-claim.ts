/** GitHub App registration and installation discovery use the native API. */
import {
  convertGithubAppManifest,
  listGithubAppInstallations,
  readGithubApp,
} from "./github-app-direct.js";
import {
  type LocalGithubApp,
  ownerFromPayload,
  pemFromVault,
  readLocalGithubApp,
  rememberLocalGithubApp,
  sealPendingGithubAppPem,
  stashPendingGithubAppSecret,
} from "./github-app-local.js";
import { GithubDirectError } from "./github-app-signing.js";
import {
  captureGithubAuthority,
  consumeGithubRegistration,
} from "./github-app-vault-transport.js";

/** A denial is not evidence that the person uninstalled their App. */
export async function verifyGithubAppInstallations(
  app: LocalGithubApp | null = readLocalGithubApp(),
): Promise<LocalGithubApp> {
  if (!app)
    throw new GithubDirectError(
      "configuration",
      "Register a GitHub App on this device first.",
    );
  const pem = pemFromVault(app);
  if (!pem)
    throw new GithubDirectError(
      "configuration",
      "Unlock the vault that holds this GitHub App key.",
    );
  let operation: ReturnType<typeof captureGithubAuthority> | null = null;
  try {
    operation = captureGithubAuthority({
      binding: () => readLocalGithubApp() === app && pemFromVault(app) === pem,
    });
    const credentials = { appId: app.id, privateKey: pem };
    const payload = await readGithubApp(operation.transport, credentials);
    operation.transport.assertCurrent();
    if (String(payload.id) !== app.id)
      throw new GithubDirectError(
        "authorization",
        "GitHub returned a different App.",
      );
    const installations = await listGithubAppInstallations(
      operation.transport,
      credentials,
    );
    operation.transport.assertCurrent();
    const next: LocalGithubApp = {
      ...app,
      ownerLogin: payload.owner?.login ?? app.ownerLogin,
      ownerType: payload.owner?.type ?? app.ownerType,
      installations: installations.map((row) => ({
        id: String(row.id),
        accountLogin: row.account.login,
        accountType: row.account.type ?? "",
      })),
    };
    rememberLocalGithubApp(next);
    return next;
  } finally {
    operation?.close();
  }
}

/** Cached presence is useful offline, but is not evidence of a verified return. */
export async function refreshGithubAppInstallations(
  app: LocalGithubApp | null = readLocalGithubApp(),
): Promise<LocalGithubApp | null> {
  try {
    return await verifyGithubAppInstallations(app);
  } catch {
    return readLocalGithubApp();
  }
}

export async function claimGithubAppCode(
  code: string,
  state: string,
): Promise<"registered" | "ignored" | "failed"> {
  if (code.trim() === "" || !consumeGithubRegistration(state)) return "ignored";
  let currentApp = readLocalGithubApp();
  let operation: ReturnType<typeof captureGithubAuthority> | null = null;
  try {
    operation = captureGithubAuthority({
      allowBeforeVault: true,
      binding: () => readLocalGithubApp() === currentApp,
    });
    const payload = await convertGithubAppManifest(operation.transport, code);
    operation.transport.assertCurrent();
    const { ownerLogin, ownerType } = ownerFromPayload(payload);
    const app: LocalGithubApp = {
      id: String(payload.id),
      key: "github-oauth",
      displayName: payload.name,
      htmlUrl: payload.html_url ?? null,
      ownerLogin,
      ownerType,
      installedByLogin: null,
      installations: [],
    };
    currentApp = app;
    rememberLocalGithubApp(app);
    operation.transport.assertCurrent();
    // A callback may arrive before unlock. Only public metadata is durable then.
    stashPendingGithubAppSecret(
      app,
      `${payload.client_secret}\n${payload.pem}`,
      operation.tomb,
    );
    await sealPendingGithubAppPem();
    operation.transport.assertCurrent();
    return "registered";
  } catch {
    return "failed";
  } finally {
    operation?.close();
  }
}
