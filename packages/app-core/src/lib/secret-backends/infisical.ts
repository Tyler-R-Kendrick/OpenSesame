import { isJsonObject, isString } from "@opensesame/os-domain";
import { createBackendHttp } from "./http.js";
import {
  infisicalItem,
  infisicalName,
  infisicalSummaries,
  infisicalWritable,
} from "./infisical-codec.js";
import { createSecretBackendSessions } from "./sessions.js";
import {
  type SecretBackend,
  type SecretBackendConfiguration,
  SecretBackendError,
  type SecretBackendFetch,
  type SecretBackendItemInput,
  type SecretBackendSession,
} from "./types.js";

type InfisicalScope = {
  projectId: string;
  environment: string;
  secretPath: string;
};
type InfisicalState = {
  request: ReturnType<typeof createBackendHttp>;
  scope: InfisicalScope;
  token: string;
};
type InfisicalWrite = InfisicalScope & {
  type: "shared";
  secretValue: string;
  secretComment: string;
  skipMultilineEncoding: boolean;
  newSecretName?: string;
};

function scopeFor(config: SecretBackendConfiguration): InfisicalScope {
  const projectId = config.projectId.trim();
  const environment = config.environment.trim();
  const secretPath = config.secretPath.trim();
  if (
    !projectId ||
    !environment ||
    !secretPath.startsWith("/") ||
    secretPath.split("/").some((part) => part === "." || part === "..")
  )
    throw new SecretBackendError(
      "configuration",
      "Enter an Infisical project ID, environment slug and absolute secret folder path.",
    );
  return { projectId, environment, secretPath };
}

function secretPath(name: string) {
  return `/api/v4/secrets/${encodeURIComponent(infisicalName(name))}`;
}

function listPath(scope: InfisicalScope): string {
  const query = new URLSearchParams({
    ...scope,
    viewSecretValue: "false",
    expandSecretReferences: "false",
    includeImports: "false",
    includePersonalOverrides: "false",
    recursive: "false",
  });
  return `/api/v4/secrets?${query}`;
}

async function authenticateToken(
  config: SecretBackendConfiguration,
  request: ReturnType<typeof createBackendHttp>,
) {
  if (!config.clientId && !config.clientSecret) {
    const token = config.token.trim();
    if (!token)
      throw new SecretBackendError(
        "configuration",
        "Enter an Infisical access token or Universal Auth client ID and secret.",
      );
    return token;
  }
  if (!config.clientId.trim() || !config.clientSecret)
    throw new SecretBackendError(
      "configuration",
      "Universal Auth requires both a client ID and client secret.",
    );
  const result = await request("/api/v1/auth/universal-auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      clientId: config.clientId.trim(),
      clientSecret: config.clientSecret,
    }),
  });
  if (
    !isJsonObject(result) ||
    !isString(result.accessToken) ||
    !result.accessToken
  )
    throw new SecretBackendError(
      "response",
      "Infisical did not return an access token.",
    );
  return result.accessToken;
}

/** Native Universal Auth and v4 REST secrets at the explicitly configured deployment. */
export function createInfisicalBackend(
  fetcher?: SecretBackendFetch,
): SecretBackend {
  const sessions = createSecretBackendSessions<InfisicalState>("infisical");
  async function call(
    session: SecretBackendSession,
    path: string,
    init: RequestInit = {},
  ) {
    const state = sessions.read(session);
    const headers = new Headers(init.headers);
    headers.set("authorization", `Bearer ${state.token}`);
    const result = await state.request(path, { ...init, headers });
    sessions.read(session);
    return result;
  }
  async function write(
    session: SecretBackendSession,
    name: string,
    item: SecretBackendItemInput,
    method: "POST" | "PATCH",
  ) {
    infisicalWritable(item);
    const { scope } = sessions.read(session);
    const body: InfisicalWrite = {
      ...scope,
      type: "shared",
      secretValue: item.secret,
      secretComment: item.notes,
      skipMultilineEncoding: true,
    };
    if (method === "PATCH") body.newSecretName = item.name;
    return infisicalItem(
      await call(session, secretPath(name), {
        method,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
  }
  return {
    id: "infisical",
    name: "Infisical",
    capabilities: {
      itemKinds: ["secret"],
      vaultBackup: { kind: "secret", field: "secret" },
      list: true,
      get: true,
      create: true,
      update: true,
      delete: true,
      import: false,
    },
    async authenticate(config) {
      const scope = scopeFor(config);
      const request = createBackendHttp(config.baseUrl, fetcher);
      const token = await authenticateToken(config, request);
      const result = await request(listPath(scope), {
        headers: { authorization: `Bearer ${token}` },
      });
      infisicalSummaries(result);
      return sessions.create({ request, token, scope });
    },
    async listItems(session) {
      return infisicalSummaries(
        await call(session, listPath(sessions.read(session).scope)),
      );
    },
    async getItem(name, session) {
      const query = new URLSearchParams({
        ...sessions.read(session).scope,
        viewSecretValue: "true",
        expandSecretReferences: "false",
        includeImports: "false",
        type: "shared",
      });
      return infisicalItem(await call(session, `${secretPath(name)}?${query}`));
    },
    async getNotes(name, session) {
      return (await this.getItem(name, session)).notes;
    },
    createItem: (item, session) => write(session, item.name, item, "POST"),
    updateItem: (id, item, session) => write(session, id, item, "PATCH"),
    async deleteItem(id, session) {
      const body = { ...sessions.read(session).scope, type: "shared" };
      await call(session, secretPath(id), {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    },
    async disconnect(session) {
      sessions.remove(session);
    },
  };
}
