import { isJsonObject, isNumber, isString } from "@opensesame/os-domain";
import { createBackendHttp } from "./http.js";
import {
  infisicalItem,
  infisicalName,
  infisicalSummaries,
  infisicalWritable,
} from "./infisical-codec.js";
import { createInfisicalLifetime } from "./infisical-lifetime.js";
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
  lifetime: ReturnType<typeof createInfisicalLifetime>;
  scope: InfisicalScope;
};
type InfisicalSessions = ReturnType<
  typeof createSecretBackendSessions<InfisicalState>
>;
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

function writeBody(
  scope: InfisicalScope,
  item: SecretBackendItemInput,
  method: "POST" | "PATCH",
): InfisicalWrite {
  infisicalWritable(item);
  const body: InfisicalWrite = {
    ...scope,
    type: "shared",
    secretValue: item.secret,
    secretComment: item.notes,
    skipMultilineEncoding: true,
  };
  if (method === "PATCH") body.newSecretName = item.name;
  return body;
}

async function authenticateToken(
  config: SecretBackendConfiguration,
  request: ReturnType<typeof createBackendHttp>,
  lifetime: ReturnType<typeof createInfisicalLifetime>,
) {
  if (!config.clientId && !config.clientSecret) {
    const token = config.token.trim();
    if (!token)
      throw new SecretBackendError(
        "configuration",
        "Enter an Infisical access token or Universal Auth client ID and secret.",
      );
    lifetime.install(token, null);
    return;
  }
  if (!config.clientId.trim() || !config.clientSecret)
    throw new SecretBackendError(
      "configuration",
      "Universal Auth requires both a client ID and client secret.",
    );
  const result = await request("/api/v1/auth/universal-auth/login", {
    signal: lifetime.signal,
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
  if (
    !isNumber(result.expiresIn) ||
    !isNumber(result.accessTokenMaxTTL) ||
    !Number.isFinite(result.accessTokenMaxTTL) ||
    result.accessTokenMaxTTL < 0 ||
    result.tokenType !== "Bearer"
  )
    throw new SecretBackendError(
      "response",
      "Infisical did not return a valid Universal Auth token lifetime.",
    );
  lifetime.install(result.accessToken, result.expiresIn);
}

async function authenticate(
  config: SecretBackendConfiguration,
  fetcher: SecretBackendFetch | undefined,
  sessions: InfisicalSessions,
) {
  const scope = scopeFor(config);
  const request = createBackendHttp(config.baseUrl, fetcher);
  const lifetime = createInfisicalLifetime(request);
  try {
    await authenticateToken(config, request, lifetime);
    const result = await lifetime.call(listPath(scope));
    infisicalSummaries(result);
    lifetime.check();
    const session = sessions.create({ lifetime, scope }, lifetime.signal);
    session.signal?.addEventListener("abort", lifetime.close, { once: true });
    if (session.signal?.aborted) lifetime.close();
    lifetime.check();
    return session;
  } catch (error) {
    lifetime.close();
    throw error;
  }
}

/** Native Universal Auth and v4 REST secrets at the explicitly configured deployment. */
export function createInfisicalBackend(
  fetcher?: SecretBackendFetch,
): SecretBackend {
  const sessions = createSecretBackendSessions<InfisicalState>("infisical");
  function owned(session: SecretBackendSession): InfisicalState {
    const state = sessions.read(session);
    state.lifetime.check();
    return state;
  }
  function checked<T>(session: SecretBackendSession, result: T): T {
    owned(session);
    return result;
  }
  async function call(
    session: SecretBackendSession,
    path: string,
    init: RequestInit = {},
  ) {
    const state = owned(session);
    const result = await state.lifetime.call(path, init);
    owned(session);
    return result;
  }
  async function write(
    session: SecretBackendSession,
    name: string,
    item: SecretBackendItemInput,
    method: "POST" | "PATCH",
  ) {
    const body = writeBody(owned(session).scope, item, method);
    return checked(
      session,
      infisicalItem(
        await call(session, secretPath(name), {
          method,
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
      ),
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
    authenticate: (config) => authenticate(config, fetcher, sessions),
    async listItems(session) {
      return checked(
        session,
        infisicalSummaries(await call(session, listPath(owned(session).scope))),
      );
    },
    async getItem(name, session) {
      const query = new URLSearchParams({
        ...owned(session).scope,
        viewSecretValue: "true",
        expandSecretReferences: "false",
        includeImports: "false",
        type: "shared",
      });
      return checked(
        session,
        infisicalItem(await call(session, `${secretPath(name)}?${query}`)),
      );
    },
    async getNotes(name, session) {
      return checked(session, (await this.getItem(name, session)).notes);
    },
    createItem: (item, session) => write(session, item.name, item, "POST"),
    updateItem: (id, item, session) => write(session, id, item, "PATCH"),
    async deleteItem(id, session) {
      const body = { ...owned(session).scope, type: "shared" };
      await call(session, secretPath(id), {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      owned(session);
    },
    async disconnect(session) {
      if (session.signal?.aborted) return;
      const { lifetime } = sessions.read(session);
      sessions.remove(session);
      lifetime.close();
    },
  };
}
