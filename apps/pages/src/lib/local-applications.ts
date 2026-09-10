import {
  type BoundaryValue,
  isJsonObject,
  isNumber,
  isString,
} from "@opensesame/os-domain";
import { exactOrigin } from "@opensesame/static-auth";
import { kvRefresh } from "./kv.js";
import {
  type LocalScopeRoles,
  defaultScopeRoles,
  isScopeRoles,
  permitsApplicationScopes,
} from "./local-application-policy.js";
import {
  LocalDirectoryError,
  readLocalDirectory,
  withLocalDirectoryLock,
} from "./local-directory.js";
import { notifyLocalIamChange } from "./local-iam-events.js";
import {
  type LocalSession,
  withLocalIdentitySession,
} from "./local-sessions.js";
import { VfsError, readFile, tombFileKey, writeFile } from "./vfs.js";

const PATH = "config/identity-applications";
const MAX_BYTES = 512_000;
export type LocalApplicationRegistration = {
  applicationId: string;
  organizationId: string;
  redirectUris: string[];
  scopes: string[];
  scopeRoles?: LocalScopeRoles[];
};
export type LocalApplication = LocalApplicationRegistration & {
  revision: number;
};
export type LocalApplications = {
  version: 2;
  revision: number;
  applications: LocalApplication[];
};

function unavailable(): never {
  throw new LocalDirectoryError("This application is unavailable.");
}
function validRedirect(raw: string): boolean {
  try {
    const url = new URL(raw);
    exactOrigin(url.origin);
    return (
      raw.length <= 2048 &&
      raw === url.href &&
      !url.username &&
      !url.password &&
      !url.hash &&
      !raw.includes("#") &&
      !raw.includes("*")
    );
  } catch {
    return false;
  }
}
function strings(value: BoundaryValue, max: number): value is string[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.length <= max &&
    value.every(isString) &&
    new Set(value).size === value.length
  );
}
function isRegistration(
  value: BoundaryValue,
): value is LocalApplicationRegistration {
  return (
    isJsonObject(value) &&
    isString(value.applicationId) &&
    /^local_[0-9a-f-]{36}$/.test(value.applicationId) &&
    isString(value.organizationId) &&
    /^local_[0-9a-f-]{36}$/.test(value.organizationId) &&
    strings(value.redirectUris, 16) &&
    value.redirectUris.every(validRedirect) &&
    strings(value.scopes, 32) &&
    value.scopes.includes("openid") &&
    value.scopes.every((scope) =>
      /^[A-Za-z0-9][A-Za-z0-9:._-]{0,63}$/.test(scope),
    ) &&
    (value.scopeRoles === undefined ||
      isScopeRoles(value.scopeRoles, value.scopes))
  );
}
function isApplication(value: BoundaryValue): value is LocalApplication {
  return (
    isJsonObject(value) &&
    isNumber(value.revision) &&
    Number.isSafeInteger(value.revision) &&
    value.revision > 0 &&
    isRegistration(value)
  );
}

function checkApplicationRevisions(
  version: 1 | 2,
  revision: number,
  applications: LocalApplication[],
) {
  if (
    applications.some(
      (app) =>
        app.revision > revision ||
        (version === 2 && app.scopeRoles === undefined),
    )
  )
    unavailable();
}

/** Encrypted custodian configuration; registration is not a resource grant. */
export async function readLocalApplications(
  tomb: string,
): Promise<LocalApplications> {
  await kvRefresh(tombFileKey(tomb, PATH), MAX_BYTES * 2);
  try {
    const bytes = await readFile(tomb, PATH);
    if (bytes.length > MAX_BYTES) unavailable();
    const value: BoundaryValue = JSON.parse(new TextDecoder().decode(bytes));
    if (
      !isJsonObject(value) ||
      (value.version !== 1 && value.version !== 2) ||
      !isNumber(value.revision) ||
      !Number.isSafeInteger(value.revision) ||
      value.revision < 0 ||
      !Array.isArray(value.applications) ||
      value.applications.length > 1000 ||
      !value.applications.every(isApplication) ||
      new Set(value.applications.map((app) => app.applicationId)).size !==
        value.applications.length
    )
      unavailable();
    const revision = value.revision;
    checkApplicationRevisions(value.version, revision, value.applications);
    return {
      version: 2,
      revision: value.revision,
      applications: value.applications,
    };
  } catch (error) {
    if (error instanceof VfsError && error.code === "not-found")
      return { version: 2, revision: 0, applications: [] };
    throw error;
  }
}

async function requireDirectoryBinding(
  tomb: string,
  app: LocalApplicationRegistration,
) {
  const directory = await readLocalDirectory(tomb);
  if (
    !directory.entries.some(
      (entry) =>
        entry.id === app.applicationId &&
        entry.kind === "application" &&
        entry.enabled,
    ) ||
    !directory.entries.some(
      (entry) =>
        entry.id === app.organizationId &&
        entry.kind === "organization" &&
        entry.enabled,
    ) ||
    !directory.memberships.some(
      (row) =>
        row.organizationId === app.organizationId && row.role === "owner",
    )
  )
    unavailable();
  return directory;
}

/** Human vault-custodian configuration. Null removes admission without deleting the directory record. */
export async function configureLocalApplication(
  tomb: string,
  revision: number,
  applicationId: string,
  registration: LocalApplicationRegistration | null,
): Promise<LocalApplications> {
  const input = registration === null ? null : structuredClone(registration);
  return withLocalDirectoryLock(tomb, async () => {
    const current = await readLocalApplications(tomb);
    if (current.revision !== revision || revision === Number.MAX_SAFE_INTEGER)
      throw new LocalDirectoryError(
        "Application configuration changed. Reload before saving.",
      );
    if (input) {
      if (!isRegistration(input) || input.applicationId !== applicationId)
        throw new LocalDirectoryError(
          "Use exact HTTPS or loopback callbacks, distinct scopes including openid, and explicit owner/admin/member scope permissions.",
        );
      await requireDirectoryBinding(tomb, input);
    }
    const applications = current.applications.filter(
      (app) => app.applicationId !== applicationId,
    );
    if (input)
      applications.push({
        applicationId,
        organizationId: input.organizationId,
        redirectUris: input.redirectUris,
        scopes: input.scopes,
        scopeRoles: input.scopeRoles ?? defaultScopeRoles(input.scopes),
        revision: revision + 1,
      });
    const next: LocalApplications = {
      version: 2,
      revision: revision + 1,
      applications,
    };
    const bytes = new TextEncoder().encode(JSON.stringify(next));
    if (applications.length > 1000 || bytes.length > MAX_BYTES)
      throw new LocalDirectoryError(
        "Application configuration exceeds its storage limit.",
      );
    try {
      await writeFile(tomb, PATH, bytes);
    } finally {
      notifyLocalIamChange();
    }
    return next;
  });
}

/** Admission preview only: no token, consent, grant, or protected action is produced. */
export async function inspectLocalApplicationRequest(
  tomb: string,
  session: LocalSession,
  applicationId: string,
  redirectUri: string,
  scopes: string[],
) {
  return withLocalApplicationRequest(
    tomb,
    session,
    applicationId,
    redirectUri,
    scopes,
    async (admission) => admission,
  );
}

export type LocalApplicationAdmission = {
  applicationId: string;
  organizationId: string;
  revision: number;
  redirectUri: string;
  scopes: string[];
};

/** Internal enforcement boundary. The callback must not reacquire the session fence. */
export async function withLocalApplicationRequest<T>(
  tomb: string,
  session: LocalSession,
  applicationId: string,
  redirectUri: string,
  scopes: string[],
  action: (
    admission: LocalApplicationAdmission,
    assertActive: () => void,
  ) => Promise<T>,
): Promise<T> {
  return withLocalIdentitySession(
    tomb,
    session,
    async (identity, assertActive) => {
      const admission = await requireLocalApplicationAdmission(
        tomb,
        identity.principalId,
        applicationId,
        redirectUri,
        scopes,
      );
      assertActive();
      return action(admission, assertActive);
    },
  );
}

/** Internal policy read: callers hold the session fence and recheck liveness before use. */
export async function requireLocalApplicationAdmission(
  tomb: string,
  principalId: string,
  applicationId: string,
  redirectUri: string,
  scopes: string[],
): Promise<LocalApplicationAdmission> {
  const app = (await readLocalApplications(tomb)).applications.find(
    (row) => row.applicationId === applicationId,
  );
  if (
    !app ||
    !validRedirect(redirectUri) ||
    !app.redirectUris.includes(redirectUri) ||
    !strings(scopes, 32) ||
    !scopes.includes("openid") ||
    !scopes.every((scope) => app.scopes.includes(scope))
  )
    unavailable();
  const directory = await requireDirectoryBinding(tomb, app);
  const member = directory.memberships.find(
    (row) =>
      row.organizationId === app.organizationId &&
      row.principalId === principalId,
  );
  if (
    !member ||
    !permitsApplicationScopes(
      app.scopeRoles ?? defaultScopeRoles(app.scopes),
      member.role,
      scopes,
    )
  )
    unavailable();
  return {
    applicationId,
    organizationId: app.organizationId,
    revision: app.revision,
    redirectUri,
    scopes: [...scopes],
  };
}
