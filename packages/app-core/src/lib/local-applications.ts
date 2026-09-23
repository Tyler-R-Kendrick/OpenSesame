import {
  type BoundaryValue,
  isJsonObject,
  isNumber,
} from "@opensesame/os-domain";
import { env } from "../host.js";
import { maybePage } from "../ports.js";
import { kvRefresh } from "./kv.js";
import {
  defaultScopeRoles,
  permitsApplicationScopes,
} from "./local-application-policy.js";
import {
  type LocalApplication,
  type LocalApplicationRegistration,
  type LocalApplications,
  isApplication,
  isRegistration,
  strings,
  validRedirect,
} from "./local-application-shape.js";
import {
  LocalDirectoryError,
  readLocalDirectory,
  withLocalDirectoryLock,
} from "./local-directory.js";
import { notifyLocalIamChange } from "./local-iam-events.js";
import { assertAccessCapability, isGuestIdentity } from "./local-rbac.js";
import {
  type LocalSession,
  withLocalIdentitySession,
} from "./local-sessions.js";
import {
  PAGES_DOGFOOD_SCOPES,
  pagesDogfoodScopeRoles,
} from "./pages-dogfood.js";
import { VfsError, readFile, tombFileKey, writeFile } from "./vfs.js";

export type {
  LocalApplication,
  LocalApplicationRegistration,
  LocalApplications,
} from "./local-application-shape.js";

const PATH = "config/identity-applications";
const MAX_BYTES = 512_000;
function unavailable(): never {
  throw new LocalDirectoryError("This application is unavailable.");
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

/**
 * Human vault-custodian configuration. Null removes admission without deleting
 * the directory record. The acting person needs `manage_policies`: a member or
 * a guest demoted beside a claimed operator may not widen an application.
 */
export async function configureLocalApplication(
  tomb: string,
  revision: number,
  applicationId: string,
  registration: LocalApplicationRegistration | null,
): Promise<LocalApplications> {
  await assertAccessCapability(tomb, "manage_policies");
  return writeLocalApplication(tomb, revision, applicationId, registration);
}

/** The write itself; bootstrap's own Pages registration comes straight here. */
async function writeLocalApplication(
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

export function pagesApplicationRedirect(): string | null {
  try {
    const origin = maybePage()?.location.origin;
    if (!origin) return null;
    const href = new URL(env().BASE_URL || "/", origin).href;
    return validRedirect(href) ? href : null;
  } catch {
    return null;
  }
}

export async function ensurePagesApplicationRegistration(
  tomb: string,
  applicationId: string,
  organizationId: string,
): Promise<void> {
  const redirect = pagesApplicationRedirect();
  if (!redirect) return;
  const current = await readLocalApplications(tomb);
  const existing = current.applications.find(
    (row) => row.applicationId === applicationId,
  );
  if (existing && existing.organizationId !== organizationId) return;
  if (
    existing &&
    existing.redirectUris.length >= 16 &&
    !existing.redirectUris.includes(redirect)
  )
    return;
  const dogfoodScopes = [...PAGES_DOGFOOD_SCOPES];
  const dogfoodRoles = pagesDogfoodScopeRoles();
  const needsRedirect = !existing?.redirectUris.includes(redirect);
  const needsScopes =
    !existing ||
    dogfoodScopes.some((scope) => !existing.scopes.includes(scope));
  if (existing && !needsRedirect && !needsScopes) return;
  const redirectUris = existing
    ? needsRedirect
      ? [...existing.redirectUris, redirect]
      : [...existing.redirectUris]
    : [redirect];
  const registration: LocalApplicationRegistration = {
    applicationId,
    organizationId,
    redirectUris,
    scopes: dogfoodScopes,
    scopeRoles: dogfoodRoles,
  };
  await writeLocalApplication(
    tomb,
    current.revision,
    applicationId,
    registration,
  );
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
  if (!member) unavailable();
  const subject = directory.entries.find((entry) => entry.id === principalId);
  if (subject && isGuestIdentity(subject)) {
    // Guests never inherit operator application scopes. openid only unless an
    // operator later widens standing shares; app admin scopes stay closed.
    if (!scopes.every((scope) => scope === "openid")) unavailable();
  }
  if (
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
