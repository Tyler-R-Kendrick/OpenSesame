import { loadSettings } from "./settings.js";

export type OrganizationRole = "owner" | "admin" | "member";

export type SessionOrganization = {
  id: string;
  displayName: string;
  role: OrganizationRole;
};

type HostSession = {
  accessToken: string;
  expiresAt: number;
  organizationId: string;
};

let hostSession: HostSession | null = null;
let pendingHostSession: Promise<HostSession> | null = null;
let pendingOrganizationId: string | null = null;
let sessionGeneration = 0;

function base(kind: "hostApi" | "identityApi") {
  return loadSettings()[kind].replace(/\/$/, "");
}

async function errorMessage(response: Response) {
  const body = (await response.json().catch(() => null)) as {
    error?: unknown;
    hint?: unknown;
    message?: unknown;
  } | null;
  return (
    [body?.hint, body?.message, body?.error].find(
      (value): value is string => typeof value === "string" && value.length > 0,
    ) ?? `Request failed (${response.status}).`
  );
}

export function clearHostSession() {
  sessionGeneration += 1;
  hostSession = null;
  pendingHostSession = null;
  pendingOrganizationId = null;
}

export async function identityFetch(path: string, init: RequestInit = {}) {
  const identity = base("identityApi");
  const url = `${identity}${path}`;
  if (new URL(url).origin !== new URL(identity).origin) {
    throw new Error("Identity request escaped the configured API origin.");
  }
  const headers = new Headers(init.headers);
  if (init.body && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  return fetch(url, {
    ...init,
    headers,
    credentials: "include",
  });
}

function parseOrganizations(value: unknown): SessionOrganization[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const raw = entry as Record<string, unknown>;
    const id = raw.id ?? raw.organization_id;
    const displayName = raw.displayName ?? raw.display_name ?? raw.name;
    const role = raw.role;
    if (
      typeof id !== "string" ||
      typeof displayName !== "string" ||
      (role !== "owner" && role !== "admin" && role !== "member")
    ) {
      return [];
    }
    return [{ id, displayName, role }];
  });
}

async function mintHostSession(organizationId: string): Promise<HostSession> {
  if (!organizationId.trim()) throw new Error("Select an organization first.");
  const host = base("hostApi");
  const authorize = await fetch(`${host}/api/v1/device/authorize`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    credentials: "omit",
    body: JSON.stringify({
      client_id: "opensesame-pages",
      scope: "opensesame.session",
    }),
  });
  if (!authorize.ok) throw new Error(await errorMessage(authorize));
  const grant = (await authorize.json()) as Record<string, unknown>;
  if (
    typeof grant.device_code !== "string" ||
    typeof grant.user_code !== "string"
  ) {
    throw new Error("Host returned an invalid device grant.");
  }
  const approve = await identityFetch("/v1/device/approve", {
    method: "POST",
    body: JSON.stringify({
      user_code: grant.user_code,
      organization_id: organizationId,
    }),
  });
  if (!approve.ok) {
    if (approve.status === 401) {
      throw new Error(
        "Sign in at the Identity API before opening Connections.",
      );
    }
    throw new Error(await errorMessage(approve));
  }
  const token = await fetch(`${host}/api/v1/device/token`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    credentials: "omit",
    body: JSON.stringify({
      device_code: grant.device_code,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    }),
  });
  if (!token.ok) throw new Error(await errorMessage(token));
  const issued = (await token.json()) as Record<string, unknown>;
  const session =
    issued.session && typeof issued.session === "object"
      ? (issued.session as Record<string, unknown>)
      : {};
  const boundOrganization = session.organization_id;
  if (boundOrganization !== organizationId) {
    throw new Error("Host session was minted for a different organization.");
  }
  if (
    typeof issued.access_token !== "string" ||
    !issued.access_token.startsWith("opaque-session:") ||
    typeof issued.expires_in !== "number" ||
    issued.expires_in <= 0
  ) {
    throw new Error("Host returned an invalid session.");
  }
  return {
    accessToken: issued.access_token,
    expiresAt: Date.now() + issued.expires_in * 1000,
    organizationId,
  };
}

async function ensureHostSession(organizationId: string) {
  if (!organizationId.trim()) throw new Error("Select an organization first.");
  if (
    hostSession &&
    hostSession.expiresAt > Date.now() &&
    hostSession.organizationId === organizationId
  ) {
    return hostSession;
  }
  if (pendingHostSession && pendingOrganizationId === organizationId) {
    return pendingHostSession;
  }
  clearHostSession();
  const generation = sessionGeneration;
  pendingOrganizationId = organizationId;
  const pending = mintHostSession(organizationId).then((session) => {
    if (sessionGeneration !== generation) {
      throw new Error(
        "Organization changed while the Host session was minted.",
      );
    }
    hostSession = session;
    return session;
  });
  pendingHostSession = pending;
  try {
    return await pending;
  } finally {
    if (pendingHostSession === pending) {
      pendingHostSession = null;
      pendingOrganizationId = null;
    }
  }
}

export async function hostFetch(
  organizationId: string,
  path: string,
  init: RequestInit = {},
) {
  async function send() {
    const active = await ensureHostSession(organizationId);
    const headers = new Headers(init.headers);
    headers.set("authorization", `Bearer ${active.accessToken}`);
    if (init.body && !headers.has("content-type")) {
      headers.set("content-type", "application/json");
    }
    const response = await fetch(`${base("hostApi")}${path}`, {
      ...init,
      headers,
      credentials: "omit",
    });
    return { response, accessToken: active.accessToken };
  }
  const first = await send();
  if (first.response.status !== 401) return first.response;
  if (hostSession?.accessToken === first.accessToken) clearHostSession();
  return (await send()).response;
}

export async function listSessionOrganizations() {
  const response = await identityFetch("/v1/organizations");
  if (!response.ok) throw new Error(await errorMessage(response));
  const body = (await response.json()) as Record<string, unknown>;
  return parseOrganizations(body.organizations);
}
