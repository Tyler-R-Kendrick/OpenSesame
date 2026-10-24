import { isJsonObject, readString } from "@opensesame/os-domain";
/** Authenticate GitHub's supported browser token route before saving readiness. */
import type { NativeApiConfigureInput } from "./native-api-connectors.js";
import { NativeApiError, nativeApiHttp } from "./native-api-http.js";
import {
  type NativeApiReadResult,
  safeNativeConnectorIcon,
  safeProviderText,
} from "./native-api-verify.js";
import {
  type NativeConnectorRecord,
  assertNativeConnectorRevision,
  saveNativeConnector,
  updateNativeConnector,
} from "./native-connector-store.js";
import {
  type NativeProviderTransport,
  nativeProviderTransport,
} from "./native-connector-transport.js";
import { nativeGithubBackupTarget } from "./native-github-backup.js";
import {
  assertNativeGithubBrowser,
  nativeGithubOrigin,
  nativeGithubToken,
  readNativeGithubAccount,
  readNativeGithubRepositories,
} from "./native-github-personal-http.js";
import {
  invalidateNativeGithubPersonal,
  nativeGithubPersonalClassification,
  nativeGithubPersonalFingerprint,
  requireNativeGithubPersonal,
  verifiedNativeGithubPersonal,
} from "./native-github-personal-state.js";
import { nativeOAuthGuard } from "./native-oauth-session.js";

function validateContractInput(input: NativeApiConfigureInput) {
  if (
    input.providerId !== "github" ||
    Object.keys(input.parameters).some(
      (key) =>
        !nativeGithubPersonalClassification.publicParameters.includes(key),
    ) ||
    Object.keys(input.credentials).some((key) => key !== "api_key") ||
    Object.keys(input.requestedScopes ?? {}).length ||
    Object.keys(input.targetIds ?? {}).length
  )
    throw new Error("Configure only a GitHub personal access token");
  if (!input.displayName.trim() || input.displayName.trim().length > 256)
    throw new Error("Enter a valid connection name");
}
function validateInput(input: NativeApiConfigureInput) {
  validateContractInput(input);
  const saved = input.connectionId
    ? requireNativeGithubPersonal(input.connectionId)
    : null;
  if (saved && input.revision !== saved.revision)
    throw new Error("Connector changed; reload before saving");
  const token = nativeGithubToken(
    input.credentials.api_key || saved?.privateState.credentials.api_key || "",
  );
  safeProviderText(input.displayName, { api_key: token });
  safeNativeConnectorIcon(input.icon ?? "", { api_key: token });
  const target = nativeGithubBackupTarget(input.parameters);
  const parameters: Record<string, string> = {};
  if (target) {
    parameters.backup_owner = target.owner;
    parameters.backup_repo = target.repo;
    parameters.backup_branch = target.branch;
  }
  for (const value of Object.values(parameters))
    safeProviderText(value, { api_key: token });
  return { saved, token, target, parameters };
}
async function verifyBackupTarget(
  target: ReturnType<typeof nativeGithubBackupTarget>,
  token: string,
  transport: NativeProviderTransport,
) {
  if (!target) return;
  const path = `/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repo)}/git/ref/heads/${target.branch.split("/").map(encodeURIComponent).join("/")}`;
  const body = await nativeApiHttp(
    {
      url: `${nativeGithubOrigin}${path}`,
      method: "GET",
      headers: new Headers({
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      }),
      signal: transport.signal,
    },
    transport,
  );
  if (
    !isJsonObject(body) ||
    body.ref !== `refs/heads/${target.branch}` ||
    !isJsonObject(body.object) ||
    body.object.type !== "commit" ||
    !/^[a-f0-9]{40}$/.test(readString(body.object.sha) ?? "")
  )
    throw new NativeApiError("response");
}
async function savedAccount(
  record: NativeConnectorRecord,
  transport: NativeProviderTransport,
) {
  assertNativeGithubBrowser();
  if (
    record.configuration.fingerprint !==
    (await nativeGithubPersonalFingerprint())
  )
    throw new Error("GitHub authorization contract changed; configure again");
  await assertNativeConnectorRevision(
    record.connectionId,
    nativeOAuthGuard(record),
  );
  try {
    const identity = await readNativeGithubAccount(
      record.privateState.credentials.api_key ?? "",
      transport,
    );
    if (record.runtime.identity && identity.id !== record.runtime.identity.id)
      throw new NativeApiError("authorization");
    await assertNativeConnectorRevision(
      record.connectionId,
      nativeOAuthGuard(record),
    );
    transport.assertCurrent();
    return identity;
  } catch (error) {
    if (error instanceof NativeApiError && error.code === "authorization")
      await invalidateNativeGithubPersonal(record, transport);
    throw error;
  }
}
async function configureAccount(
  saved: NativeConnectorRecord | null,
  token: string,
  transport: NativeProviderTransport,
  target: ReturnType<typeof nativeGithubBackupTarget>,
) {
  try {
    const identity = await readNativeGithubAccount(token, transport);
    await verifyBackupTarget(target, token, transport);
    return identity;
  } catch (error) {
    if (
      saved &&
      saved.privateState.credentials.api_key === token &&
      error instanceof NativeApiError &&
      error.code === "authorization"
    )
      await invalidateNativeGithubPersonal(saved, transport);
    throw error;
  }
}
export async function configureNativeGithubPersonal(
  input: NativeApiConfigureInput,
  transport: NativeProviderTransport = nativeProviderTransport(),
) {
  transport.assertCurrent();
  assertNativeGithubBrowser();
  const { saved, token, target, parameters } = validateInput(input);
  if (saved)
    await assertNativeConnectorRevision(
      saved.connectionId,
      nativeOAuthGuard(saved),
    );
  const identity = await configureAccount(saved, token, transport, target);
  const fingerprint = await nativeGithubPersonalFingerprint();
  transport.assertCurrent();
  const id = saved?.connectionId ?? `conn_github_${crypto.randomUUID()}`;
  const next = verifiedNativeGithubPersonal(
    id,
    saved?.revision ?? 1,
    {
      version: 1,
      providerId: "github",
      method: "api-key",
      displayName: input.displayName.trim(),
      icon: input.icon ?? "",
      parameters,
      requestedScopes: {},
      targetIds: { api: nativeGithubOrigin },
      fingerprint,
    },
    token,
    identity,
    saved?.runtime.verifiedAt ?? 0,
  );
  if (!saved)
    return saveNativeConnector(next, nativeGithubPersonalClassification, () =>
      transport.assertCurrent(),
    );
  return updateNativeConnector(
    id,
    nativeOAuthGuard(saved),
    nativeGithubPersonalClassification,
    () => {
      transport.assertCurrent();
      return next;
    },
    () => transport.assertCurrent(),
  );
}
export async function verifyNativeGithubPersonal(
  id: string,
  transport: NativeProviderTransport = nativeProviderTransport(),
) {
  const record = requireNativeGithubPersonal(id);
  const identity = await savedAccount(record, transport);
  await verifyBackupTarget(
    nativeGithubBackupTarget(record.configuration.parameters),
    record.privateState.credentials.api_key ?? "",
    transport,
  );
  return updateNativeConnector(
    id,
    nativeOAuthGuard(record),
    nativeGithubPersonalClassification,
    () => {
      transport.assertCurrent();
      return verifiedNativeGithubPersonal(
        id,
        record.revision,
        record.configuration,
        record.privateState.credentials.api_key ?? "",
        identity,
        record.runtime.verifiedAt ?? 0,
      );
    },
    () => transport.assertCurrent(),
  );
}
export async function invokeNativeGithubPersonal(
  id: string,
  operation: string,
  input: Record<string, string> = {},
  transport: NativeProviderTransport = nativeProviderTransport(),
): Promise<NativeApiReadResult> {
  transport.assertCurrent();
  if (
    !["provider.read", "provider.repositories.read"].includes(operation) ||
    Object.keys(input).length
  )
    throw new Error("Unsupported GitHub personal-token operation");
  const record = requireNativeGithubPersonal(id, true);
  const identity = await savedAccount(record, transport);
  if (operation === "provider.read")
    return { label: identity.label, items: [] };
  try {
    const items = await readNativeGithubRepositories(
      record.privateState.credentials.api_key ?? "",
      transport,
    );
    transport.assertCurrent();
    await assertNativeConnectorRevision(id, nativeOAuthGuard(record));
    return { label: "Recently updated repositories (up to 100)", items };
  } catch (error) {
    if (error instanceof NativeApiError && error.code === "authorization")
      await invalidateNativeGithubPersonal(record, transport);
    throw error;
  }
}
export { nativeGithubPersonalCleanup } from "./native-github-personal-state.js";
