/** Native Google issuer class proof and an explicit, payload-screened Save-to-Wallet handoff. */
import { canonicalize, isJsonObject, isString } from "@opensesame/os-domain";
import type { BoundaryValue } from "@opensesame/os-domain";
import {
  type GoogleWalletEnabled,
  parseGoogleWalletConfig,
} from "@opensesame/wallet/config";
import {
  type GoogleClient,
  createGoogleClient,
} from "@opensesame/wallet/google-client";
import { GOOGLE_WALLET_CONFIGURATION_POLICY as WALLET_POLICY } from "@opensesame/wallet/google-wallet-policy";
import { z } from "zod";
import { canonicalProviderId } from "./connector-catalog.js";
import type { NativeApiConfigureInput } from "./native-api-connectors.js";
import { NativeApiError } from "./native-api-http.js";
import {
  safeNativeConnectorIcon,
  safeProviderText,
} from "./native-api-verify.js";
import {
  type NativeConnectorRecord,
  assertNativeConnectorRevision,
} from "./native-connector-store.js";
import type { NativeProviderTransport } from "./native-connector-transport.js";
import { googleWalletTransportFlows } from "./native-google-wallet-transport.js";
import { googleWalletUi } from "./native-google-wallet-ui.js";
import { createNativeKeyFlows } from "./native-key-driver.js";
import type { NativeKeySpec, NativeKeyTarget } from "./native-key-types.js";
import { nativeOAuthGuard } from "./native-oauth-session.js";
import { nativeResponseJson } from "./native-response-json.js";
import { zodJitless } from "./zod-jitless.js";
zodJitless();
const TOKEN = "https://oauth2.googleapis.com/token";
const PUBLIC = ["issuer_id", "class_id", "origin", "client_email"];
const PRIVATE = ["service_account_json"];
type Target = NativeKeyTarget & {
  saved?: { id: string; guard: ReturnType<typeof nativeOAuthGuard> };
};
const tokenReply = z.object({
  access_token: z.string().regex(/^[A-Za-z0-9._~+/=-]{20,4096}$/),
  expires_in: z.number().int().positive().max(86400),
  token_type: z.literal("Bearer").optional(),
});
const accepts = (id: string) => canonicalProviderId(id) === "google-wallet";
function parseWalletServiceAccount(text: string) {
  let parsed: BoundaryValue;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("Paste the service account key file, a JSON document");
  }
  if (
    !isJsonObject(parsed) ||
    parsed.type !== WALLET_POLICY.nativeServiceAccount.type ||
    !isString(parsed.client_email) ||
    !new RegExp(WALLET_POLICY.nativeServiceAccount.emailPattern).test(
      parsed.client_email,
    ) ||
    !isString(parsed.private_key) ||
    !new RegExp(WALLET_POLICY.nativeServiceAccount.keyPemPattern).test(
      parsed.private_key,
    )
  )
    throw new Error("That is not a service account key file");
  return { clientEmail: parsed.client_email, privateKey: parsed.private_key };
}
function config(target: NativeKeyTarget): GoogleWalletEnabled {
  const account = parseWalletServiceAccount(
    target.credentials.service_account_json ?? "",
  );
  const result = parseGoogleWalletConfig({
    OPENSESAME_WALLET_GOOGLE_ISSUER_ID: target.parameters.issuer_id,
    OPENSESAME_WALLET_GOOGLE_CLASS_ID: target.parameters.class_id,
    OPENSESAME_WALLET_GOOGLE_SERVICE_ACCOUNT_EMAIL: account.clientEmail,
    OPENSESAME_WALLET_GOOGLE_SERVICE_ACCOUNT_KEY: account.privateKey,
    OPENSESAME_WALLET_GOOGLE_PUBLIC_BASE_URL: target.parameters.origin,
    OPENSESAME_WALLET_GOOGLE_ORIGINS: target.parameters.origin,
  });
  if (!result.enabled) throw new Error("Configure the Google Wallet issuer");
  return result;
}
function fields(input: NativeApiConfigureInput) {
  if (
    !accepts(input.providerId) ||
    Object.keys(input.requestedScopes ?? {}).length ||
    Object.keys(input.targetIds ?? {}).length ||
    Object.keys(input.parameters).some((key) => !PUBLIC.includes(key)) ||
    Object.keys(input.credentials).some((key) => !PRIVATE.includes(key))
  )
    throw new Error(
      "Configure only the Google Wallet issuer, class, origin and service-account key",
    );
}
function parse(
  input: NativeApiConfigureInput,
  saved: NativeConnectorRecord | null,
): Target {
  fields(input);
  const credentials = {
    service_account_json:
      input.credentials.service_account_json ||
      saved?.privateState.credentials.service_account_json ||
      "",
  };
  if (
    credentials.service_account_json.length >
    WALLET_POLICY.nativeServiceAccount.jsonMaxLength
  )
    throw new Error("Supply a bounded service-account JSON key");
  const target: Target = {
    providerId: input.providerId,
    parameters: { ...input.parameters },
    credentials,
  };
  try {
    const parsed = config(target);
    if (
      new URL(target.parameters.origin ?? "").origin !==
      target.parameters.origin
    )
      throw new Error("Use an HTTPS origin without a path");
    target.parameters = {
      issuer_id: parsed.issuerId,
      class_id: parsed.classId,
      origin: parsed.origins[0] ?? "",
      client_email: parsed.serviceAccountEmail,
    };
    for (const text of [...Object.values(target.parameters), input.displayName])
      safeProviderText(text, credentials);
    safeNativeConnectorIcon(input.icon ?? "", credentials);
  } catch {
    throw new Error(
      "Enter a valid issuer, class, HTTPS presenting origin and service-account JSON key",
    );
  }
  if (saved)
    target.saved = { id: saved.connectionId, guard: nativeOAuthGuard(saved) };
  return target;
}
function httpFailure(status: number): NativeApiError {
  if ([400, 401].includes(status))
    return new NativeApiError("authorization", status);
  if (status === 403) return new NativeApiError("permission", status);
  if (status === 429) return new NativeApiError("rate-limit", status);
  return new NativeApiError("response", status);
}
async function googleRequestInit(
  request: Request,
  signal: AbortSignal,
  token: boolean,
): Promise<RequestInit> {
  const init: RequestInit = {
    method: request.method,
    headers: request.headers,
    signal,
    credentials: "omit",
    redirect: "error",
    cache: "no-store",
    referrerPolicy: "no-referrer",
  };
  if (token) init.body = await request.text();
  return init;
}
/** A fresh client per operation, bound to one route and saved revision, with no ambient fallback. */
async function run<T>(
  target: Target,
  transport: NativeProviderTransport,
  call: (client: GoogleClient) => Promise<T>,
): Promise<T> {
  const configured = config(target);
  const classUrl = `https://walletobjects.googleapis.com/walletobjects/v1/genericClass/${encodeURIComponent(configured.classId)}`;
  let failure: NativeApiError | null = null;
  const current = async () => {
    transport.assertCurrent();
    if (target.saved)
      await assertNativeConnectorRevision(target.saved.id, target.saved.guard);
    transport.assertCurrent();
  };
  const responses = new WeakMap<
    Response,
    { signal: AbortSignal; token: boolean }
  >();
  const fetchImpl: typeof fetch = async (input, options) => {
    await current();
    const request = new Request(input, options);
    const token = request.url === TOKEN && request.method === "POST";
    if (!token && (request.url !== classUrl || request.method !== "GET"))
      throw new NativeApiError("deployment");
    const signals = [request.signal, AbortSignal.timeout(15000)];
    if (transport.signal) signals.push(transport.signal);
    const signal = AbortSignal.any(signals);
    const init = await googleRequestInit(request, signal, token);
    await current();
    let response: Response | undefined;
    try {
      response = await transport.fetch(request.url, init);
      await current();
      if (!response.ok || response.redirected)
        throw httpFailure(response.status);
      responses.set(response, { signal, token });
      return response;
    } catch (error) {
      await response?.body?.cancel().catch(() => undefined);
      await current();
      failure =
        error instanceof NativeApiError ? error : new NativeApiError("network");
      throw failure;
    }
  };
  const readResponseJson = async (response: Response, maxBytes: number) => {
    const owned = responses.get(response);
    if (!owned || maxBytes !== (owned.token ? 16384 : 65536))
      throw new NativeApiError("deployment");
    try {
      await current();
      const body = await nativeResponseJson(response, {
        maxBytes,
        signal: owned.signal,
      });
      await current();
      return owned.token ? tokenReply.parse(body) : body;
    } catch (error) {
      await current();
      failure =
        error instanceof NativeApiError
          ? error
          : new NativeApiError("response");
      throw failure;
    } finally {
      responses.delete(response);
    }
  };
  await current();
  try {
    const result = await call(
      createGoogleClient({ config: configured, fetchImpl, readResponseJson }),
    );
    await current();
    return result;
  } catch {
    await current();
    throw failure ?? new NativeApiError("response");
  }
}

const spec: NativeKeySpec<Target> = {
  family: "Google Wallet",
  idPrefix: "conn_google_wallet_",
  accepts,
  classification: { publicParameters: PUBLIC, privateCredentials: PRIVATE },
  ui: () => googleWalletUi,
  parse,
  fingerprint: async (target) => {
    const encoded = new TextEncoder().encode(
      canonicalize({
        contract: "google-wallet:issuer-class:v1",
        parameters: target.parameters,
        credentials: target.credentials,
      }),
    );
    return [...new Uint8Array(await crypto.subtle.digest("SHA-256", encoded))]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
  },
  prove: async (target, transport) => {
    await run(target, transport, (client) => client.verifyGenericClass());
    const id = target.parameters.class_id ?? "";
    return {
      identity: {
        id: target.parameters.client_email ?? "",
        label: target.parameters.client_email ?? "",
        kind: "service-account",
      },
      targets: [{ id, label: id, kind: "pass-class" }],
      grantLabel: "Google Wallet configured class access",
      target: { key: "class", id },
    };
  },
  targetOf: (saved) =>
    parse(
      {
        providerId: saved.configuration.providerId,
        displayName: saved.configuration.displayName,
        icon: saved.configuration.icon,
        parameters: saved.configuration.parameters,
        credentials: saved.privateState.credentials,
      },
      saved,
    ),
  operations: [
    {
      id: "provider.pass.prepare",
      inputKeys: ["title", "header"],
      run: async (target, transport, input) => {
        const title = input.title ?? "";
        const header = input.header ?? "";
        for (const text of [title, header])
          if (
            !text.trim() ||
            text.length > 120 ||
            [...text].some(
              (character) =>
                character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
            )
          )
            throw new Error("Supply bounded public pass title and header text");
        return run(target, transport, async (client) => {
          await client.verifyGenericClass();
          const object = {
            id: `${client.config.issuerId}.os_${crypto.randomUUID().replaceAll("-", "")}`,
            classId: client.config.classId,
            state: "ACTIVE",
            cardTitle: {
              defaultValue: { language: "en-US", value: title },
            },
            header: {
              defaultValue: { language: "en-US", value: header },
            },
          };
          const url = await client.signSaveUrl([object]);
          return {
            label: "Save link prepared",
            items: [{ id: object.id, label: "Save to Google Wallet", url }],
          };
        });
      },
    },
  ],
};
export const googleWalletKeyFlows = googleWalletTransportFlows(
  createNativeKeyFlows(spec),
);
