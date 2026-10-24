import type { BoundaryValue } from "@opensesame/os-domain";
/**
 * Direct browser Key Vault secret values. PUT creates a new immutable version;
 * DELETE removes the whole logical secret/version chain under soft-delete policy.
 * No purge, single-version deletion, ETag CAS or atomic create-if-absent is claimed.
 * The caller supplies an audience-correct Bearer grant; Graph grants are not reused.
 */
import {
  AZURE_API_VERSION,
  AZURE_RESPONSE_BYTES,
  AZURE_SECRET_BYTES,
  type AzureSecretBundle,
  type AzureSecretReference,
  type AzureSecretWrite,
  azureDeleteAllowed,
  azureDeletedSecret,
  azureNextPage,
  azureSecretBundle,
  azureSecretItem,
  azureSecretName,
  azureSecretPage,
  azureSecretPath,
  azureSecretReference,
  azureSecretWrite,
  azureVaultBase,
} from "./azure-key-vault-codec.js";
import { SecretBackendHttpError } from "./http.js";
import { createSecretBackendSessions } from "./sessions.js";
import {
  type SecretBackendTransport,
  fenceSecretBackend,
  guardSecretBackendTransport,
} from "./transport.js";
import {
  type SecretBackend,
  type SecretBackendConfiguration,
  SecretBackendError,
  type SecretBackendItemInput,
  type SecretBackendItemSummary,
  type SecretBackendSession,
} from "./types.js";

type AzureState = {
  base: URL;
  token: string;
  transport: SecretBackendTransport;
};
const MAX_PAGES = 128;
const MAX_ITEMS = MAX_PAGES * 25;
function failure(message: string): SecretBackendError {
  return new SecretBackendError("response", message);
}
function responseHeaders(response: Response): void {
  try {
    const media = response.headers
      .get("content-type")
      ?.split(";", 1)[0]
      ?.trim()
      .toLowerCase();
    if (media !== "application/json")
      throw failure("Azure returned a non-JSON response.");
    const declared = response.headers.get("content-length");
    if (
      declared !== null &&
      (!/^\d+$/.test(declared) || Number(declared) > AZURE_RESPONSE_BYTES)
    )
      throw failure("Azure response exceeds the supported size.");
  } catch (error) {
    void response.body?.cancel().catch(() => undefined);
    throw error;
  }
}
async function readBody(
  response: Response,
  signal: AbortSignal,
): Promise<BoundaryValue> {
  responseHeaders(response);
  const reader = response.body?.getReader();
  if (!reader) throw failure("Azure returned an empty response.");
  const bytes = new Uint8Array(AZURE_RESPONSE_BYTES);
  let size = 0;
  let completed = false;
  let abort: () => void = () => undefined;
  const ended = new Promise<never>((_, reject) => {
    abort = () =>
      reject(new SecretBackendError("stale", "The Azure operation ended."));
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
  try {
    for (;;) {
      const part = await Promise.race([reader.read(), ended]);
      if (part.done) {
        completed = true;
        break;
      }
      if (!part.value.byteLength || part.value.byteLength > bytes.length - size)
        throw failure("Azure response exceeds the supported size.");
      bytes.set(part.value, size);
      size += part.value.byteLength;
    }
    const parsed: BoundaryValue = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, size)),
    );
    signal.throwIfAborted();
    return parsed;
  } catch (error) {
    if (error instanceof SecretBackendError) throw error;
    throw failure("Azure returned an unreadable response.");
  } finally {
    signal.removeEventListener("abort", abort);
    if (!completed) void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
function requestHeaders(
  token: string,
  value: AzureSecretWrite | undefined,
): Headers {
  const headers = new Headers({
    Authorization: `Bearer ${token}`,
    Accept: "application/json",
  });
  if (value !== undefined) headers.set("Content-Type", "application/json");
  return headers;
}
async function request(
  state: AzureState,
  target: URL,
  method = "GET",
  value?: AzureSecretWrite,
): Promise<BoundaryValue> {
  state.transport.assertCurrent();
  const signal = AbortSignal.any([
    state.transport.signal,
    AbortSignal.timeout(20_000),
  ]);
  let response: Response;
  try {
    response = await state.transport.fetch(target.href, {
      method,
      headers: requestHeaders(state.token, value),
      body: value === undefined ? null : JSON.stringify(value),
      signal,
      redirect: "error",
      credentials: "omit",
      cache: "no-store",
      referrerPolicy: "no-referrer",
    });
  } catch (error) {
    state.transport.assertCurrent();
    if (error instanceof SecretBackendError) throw error;
    throw new SecretBackendError(
      "network",
      "Azure request failed. Check the vault URL, TLS and browser access.",
    );
  }
  state.transport.assertCurrent();
  if (response.status !== 200) {
    const code =
      response.status === 401 || response.status === 403
        ? "authentication"
        : response.status === 404
          ? "not-found"
          : "response";
    try {
      throw await SecretBackendHttpError.fromResponse(
        response,
        code,
        `Azure request failed (HTTP ${response.status}).`,
        signal,
      );
    } finally {
      void response.body?.cancel().catch(() => undefined);
    }
  }
  const result = await readBody(response, signal);
  state.transport.assertCurrent();
  return result;
}
function endpoint(state: AzureState, path: string): URL {
  const url = new URL(path, state.base);
  url.searchParams.set("api-version", AZURE_API_VERSION);
  return url;
}
async function readSecret(
  state: AzureState,
  ref: AzureSecretReference,
): Promise<AzureSecretBundle> {
  return azureSecretBundle(
    await request(state, endpoint(state, azureSecretPath(ref))),
    state.base,
    ref,
  );
}
async function list(state: AzureState): Promise<SecretBackendItemSummary[]> {
  let url: URL | undefined = endpoint(state, "/secrets");
  url.searchParams.set("maxresults", "25");
  const seen = new Set<string>();
  const ids = new Set<string>();
  const items: SecretBackendItemSummary[] = [];
  while (url) {
    if (seen.has(url.href) || seen.size >= MAX_PAGES)
      throw failure("Azure pagination exceeded its bounded traversal.");
    seen.add(url.href);
    const page = azureSecretPage(await request(state, url), state.base);
    for (const item of page.items) {
      if (ids.has(item.id) || items.length >= MAX_ITEMS)
        throw failure("Azure returned duplicate or excessive secrets.");
      ids.add(item.id);
      items.push(item);
    }
    url = page.next ? azureNextPage(page.next, state.base) : undefined;
  }
  return items;
}
function credentials(
  config: Pick<SecretBackendConfiguration, "baseUrl" | "token">,
  transport: SecretBackendTransport,
): AzureState {
  if (!/^[\x21-\x7e]{1,16384}$/.test(config.token))
    throw new SecretBackendError(
      "configuration",
      "Supply a Key Vault audience Bearer access token.",
    );
  return {
    base: azureVaultBase(config.baseUrl),
    token: config.token,
    transport,
  };
}
function mutableReference(id: string, state: AzureState): AzureSecretReference {
  const ref = azureSecretReference(id, state.base);
  if (ref.version)
    throw new SecretBackendError(
      "unsupported",
      "Use the logical secret ID for writes; Azure cannot update or delete an individual version.",
    );
  return ref;
}
async function put(
  state: AzureState,
  ref: AzureSecretReference,
  input: SecretBackendItemInput,
  previous?: AzureSecretBundle,
) {
  if (azureSecretName(input.name) !== ref.name)
    throw new SecretBackendError(
      "unsupported",
      "Azure secret names are immutable. Create a separate secret to rename one.",
    );
  const value = azureSecretWrite(input, previous);
  const result = azureSecretBundle(
    await request(state, endpoint(state, azureSecretPath(ref)), "PUT", value),
    state.base,
    ref,
  );
  if (result.value !== input.secret || result.id === previous?.id)
    throw failure("Azure did not return the newly written secret version.");
  return azureSecretItem(result, state.base);
}
const azureCapabilities: SecretBackend["capabilities"] = {
  itemKinds: ["secret"],
  itemFields: ["secret"],
  vaultBackup: {
    kind: "secret",
    field: "secret",
    maxBytes: AZURE_SECRET_BYTES,
  },
  list: true,
  get: true,
  create: true,
  update: true,
  delete: true,
  import: false,
};
function azureBackend(captured: SecretBackendTransport) {
  const owner = guardSecretBackendTransport(captured);
  const sessions = createSecretBackendSessions<AzureState>(
    "azure-key-vault-secrets",
  );
  const held = (session: Parameters<typeof sessions.read>[0]) => {
    const state = sessions.read(session);
    return {
      ...state,
      transport: guardSecretBackendTransport(
        state.transport,
        undefined,
        session.signal,
      ),
    };
  };
  const authenticate = async (
    config: Pick<SecretBackendConfiguration, "baseUrl" | "token">,
  ) => {
    const state = credentials(config, owner);
    await list(state);
    owner.assertCurrent();
    return sessions.create(state, owner.signal);
  };
  const backend: SecretBackend = {
    id: "azure-key-vault-secrets",
    name: "Azure Key Vault Secrets",
    capabilities: azureCapabilities,
    authenticate,
    async listItems(session) {
      return list(held(session));
    },
    async getItem(id, session) {
      const state = held(session);
      return azureSecretItem(
        await readSecret(state, azureSecretReference(id, state.base)),
        state.base,
      );
    },
    async getNotes(id, session) {
      return (await backend.getItem(id, session)).secret;
    },
    async createItem(input, session) {
      const state = held(session);
      const ref = azureSecretReference(azureSecretName(input.name), state.base);
      azureSecretWrite(input);
      try {
        await readSecret(state, ref);
      } catch (error) {
        if (!(error instanceof SecretBackendHttpError) || error.status !== 404)
          throw error;
        return put(state, ref, input);
      }
      throw new SecretBackendError(
        "ambiguous",
        "An Azure secret already uses this name. Choose another name or update it.",
      );
    },
    async updateItem(id, input, session) {
      const state = held(session);
      const ref = mutableReference(id, state);
      azureSecretWrite(input);
      return put(state, ref, input, await readSecret(state, ref));
    },
    async deleteItem(id, session) {
      const state = held(session);
      const ref = mutableReference(id, state);
      azureDeleteAllowed(await readSecret(state, ref));
      const result = await request(
        state,
        endpoint(state, azureSecretPath(ref)),
        "DELETE",
      );
      azureDeletedSecret(result, state.base, ref);
    },
    async disconnect(session) {
      sessions.remove(session);
    },
  };
  return { backend: fenceSecretBackend(backend, owner), authenticate, owner };
}

export function createAzureKeyVaultSecretBackend(
  captured: SecretBackendTransport,
): SecretBackend {
  return azureBackend(captured).backend;
}
/** Native saved custody already owns the credential; no synthetic draft/mode is created. */
export async function openAzureKeyVaultSecretBackend(
  config: Pick<SecretBackendConfiguration, "baseUrl" | "token">,
  captured: SecretBackendTransport,
) {
  const opened = azureBackend(captured);
  let session: SecretBackendSession | undefined;
  try {
    session = await opened.authenticate(config);
    opened.owner.assertCurrent();
    return { backend: opened.backend, session };
  } catch (error) {
    if (session) await opened.backend.disconnect(session);
    throw error;
  }
}
