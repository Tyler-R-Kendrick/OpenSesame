/**
 * Browser-local backends for the device-native Identity host (ADR 0118).
 *
 * Routes that used to 501 or return empty shells when Settings had no remote
 * Identity URL are answered from modules the Identity screens already use:
 * vault projects, local directory, local application registrations.
 */

import { isString } from "@opensesame/os-domain";
import { auditRoute, requestsRoute } from "./device-identity-inbox.js";
import type { DeviceRouteContribution } from "./device-identity-routes.js";
import { readLocalApplications } from "./local-applications.js";
import { readLocalDirectory } from "./local-directory.js";
import {
  PERSONAL_PROJECT_ID,
  type PagesProject,
  listProjects,
} from "./projects.js";
import { vaultStore } from "./vault/store.js";
import { PERSONAL_TOMB } from "./vfs.js";

type ProjectSummary = {
  id: string;
  slug: string;
  displayName: string;
  state: string;
  sealedStoreTombName: string;
  created?: boolean;
};

type OrgRow = {
  id: string;
  slug: string;
  displayName: string;
  role: string;
  state: string;
};

type AgentRow = {
  id: string;
  displayName: string;
  state: string;
  createdAt: string;
};

type OauthClientRow = {
  id: string;
  displayName: string;
  admissionMode: string;
  state: string;
  redirectUris: string[];
  sectorIdentifier: string;
  tokenEndpointAuthMethod: string;
  allowedScopes: string[];
  createdAt: string;
  updatedAt: string;
};

function jsonResponse(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "application/json" },
  });
}

function notImplemented(path: string): Response {
  return jsonResponse(
    JSON.stringify({
      error: "device_identity",
      hint: `This device identity host does not implement ${path}. Use the matching local Identity screen, or connect a sign-in service if your organisation provides one.`,
    }),
    501,
  );
}

function activeTomb(): string {
  const tomb = vaultStore.activeTomb().trim();
  return tomb.length > 0 ? tomb : PERSONAL_TOMB;
}

function projectSummary(
  project: PagesProject,
  created: boolean,
): ProjectSummary {
  const personal =
    project.id === PERSONAL_PROJECT_ID || project.kind === "personal";
  const base = {
    id: project.id,
    slug: personal ? "personal" : project.id,
    displayName: project.name,
    state: "active",
    sealedStoreTombName: project.id,
  } satisfies ProjectSummary;
  if (created) {
    return { ...base, created: true };
  }
  return base;
}

/** GET /v1/projects — vault projects on this device. */
export function localProjectsList(): Response {
  const projects = listProjects().map((project) =>
    projectSummary(project, false),
  );
  return jsonResponse(JSON.stringify({ projects }));
}

/**
 * POST /v1/projects/personal/ensure — personal vault project always exists
 * locally; answer the same shape the control-plane ensure returns.
 */
export function localProjectsEnsurePersonal(): Response {
  const personal =
    listProjects().find(
      (project) =>
        project.id === PERSONAL_PROJECT_ID || project.kind === "personal",
    ) ?? listProjects()[0];
  if (!personal) {
    return jsonResponse(
      JSON.stringify({
        error: "device_identity",
        hint: "No vault projects are registered on this device yet.",
      }),
      500,
    );
  }
  return jsonResponse(JSON.stringify(projectSummary(personal, false)));
}

/** GET /v1/organizations — memberships from the unlocked local directory. */
export async function localOrganizationsList(): Promise<Response> {
  try {
    const directory = await readLocalDirectory(activeTomb());
    const organizations: OrgRow[] = directory.memberships.flatMap((row) => {
      const org = directory.entries.find(
        (entry) =>
          entry.id === row.organizationId &&
          entry.kind === "organization" &&
          entry.enabled,
      );
      if (!org) return [];
      const slug = org.id.replace(/^org[_:]?/, "") || org.id;
      return [
        {
          id: org.id,
          slug,
          displayName: org.name,
          role: row.role,
          state: "active",
        },
      ];
    });
    return jsonResponse(JSON.stringify({ organizations }));
  } catch {
    return jsonResponse(
      JSON.stringify({ organizations: [] satisfies OrgRow[] }),
    );
  }
}

/** GET /v1/agents — agents from the unlocked local directory. */
export async function localAgentsList(): Promise<Response> {
  try {
    const directory = await readLocalDirectory(activeTomb());
    const agents: AgentRow[] = directory.entries
      .filter((entry) => entry.kind === "agent" && entry.enabled)
      .map((entry) => ({
        id: entry.id,
        displayName: entry.name,
        state: "active",
        createdAt: new Date(0).toISOString(),
      }));
    return jsonResponse(JSON.stringify({ agents }));
  } catch {
    return jsonResponse(JSON.stringify({ agents: [] satisfies AgentRow[] }));
  }
}

/**
 * GET /v1/oauth/clients — project local application registrations into the
 * Sites/OAuth-client list shape. Mutations stay on Identity → Applications.
 */
export async function localOauthClientsList(): Promise<Response> {
  try {
    const apps = await readLocalApplications(activeTomb());
    const directory = await readLocalDirectory(activeTomb());
    const clients: OauthClientRow[] = apps.applications.map((app) => {
      const org = directory.entries.find(
        (entry) => entry.id === app.organizationId,
      );
      const name =
        (org && isString(org.name) ? org.name : null) ?? app.applicationId;
      const firstRedirect = app.redirectUris[0];
      let sector = app.applicationId;
      if (firstRedirect !== undefined) {
        try {
          sector = new URL(firstRedirect).origin;
        } catch {
          sector = app.applicationId;
        }
      }
      return {
        id: app.applicationId,
        displayName: name,
        admissionMode: "local",
        state: "active",
        redirectUris: app.redirectUris,
        sectorIdentifier: sector,
        tokenEndpointAuthMethod: "none",
        allowedScopes: app.scopes,
        createdAt: new Date(0).toISOString(),
        updatedAt: new Date(0).toISOString(),
      };
    });
    return jsonResponse(JSON.stringify({ clients }));
  } catch {
    return jsonResponse(
      JSON.stringify({ clients: [] satisfies OauthClientRow[] }),
    );
  }
}

async function handleOauth(
  bare: string,
  method: string,
): Promise<Response | null> {
  if (bare !== "/v1/oauth/clients") return null;
  if (method === "GET") return localOauthClientsList();
  return notImplemented(`${method} ${bare}`);
}

async function handleOrgs(
  bare: string,
  method: string,
): Promise<Response | null> {
  if (bare !== "/v1/organizations") return null;
  if (method === "GET") return localOrganizationsList();
  return notImplemented(`${method} ${bare}`);
}

async function handleAgents(
  bare: string,
  method: string,
): Promise<Response | null> {
  if (bare !== "/v1/agents" && !bare.startsWith("/v1/agents/")) return null;
  if (method === "GET") return localAgentsList();
  return notImplemented(`${method} ${bare}`);
}

async function handleProjects(
  bare: string,
  method: string,
): Promise<Response | null> {
  const isProjects =
    bare === "/v1/projects" ||
    bare === "/v1/projects/personal/ensure" ||
    bare.startsWith("/v1/projects/");
  if (!isProjects) return null;
  if (method === "GET" && bare === "/v1/projects") return localProjectsList();
  if (method === "POST" && bare.endsWith("/ensure")) {
    return localProjectsEnsurePersonal();
  }
  return notImplemented(`${method} ${bare}`);
}

/** The directory family: oauth clients, organizations, agents, projects. */
async function directoryRoute(
  bare: string,
  method: string,
): Promise<Response | null> {
  return (
    (await handleOauth(bare, method)) ??
    (await handleOrgs(bare, method)) ??
    (await handleAgents(bare, method)) ??
    (await handleProjects(bare, method))
  );
}

/**
 * What `identity.local-iam` contributes to the device plane (ADR 0160): the
 * directory (people, agents, organizations, projects, applications), the
 * receipts and the request inbox (`device-identity-inbox.ts`, ADR 0162), all
 * read from this vault. It registers this from `activate` and unregisters on
 * dispose. The email and text code
 * routes are not here: no capability serves them on a device, and the host
 * answers them itself.
 */
export const LOCAL_IAM_DEVICE_ROUTES: DeviceRouteContribution = {
  id: "identity.local-iam",
  routes: {
    directory: ({ bare, method }) => directoryRoute(bare, method),
    audit: auditRoute,
    requests: requestsRoute,
  },
};
