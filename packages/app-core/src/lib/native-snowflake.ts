/** Operator-owned PAT or already-issued OAuth token, proved by real database metadata. */
import { canonicalize } from "@opensesame/os-domain";
import { z } from "zod";
import type { NativeApiConfigureInput } from "./native-api-connectors.js";
import {
  safeNativeConnectorIcon,
  safeProviderText,
} from "./native-api-verify.js";
import type { NativeConnectorRecord } from "./native-connector-store.js";
import { createNativeKeyFlows } from "./native-key-driver.js";
import type { NativeKeyUi } from "./native-key-types.js";
import {
  type SnowflakeTarget,
  readSnowflakeDatabases,
  snowflakeOrigin,
} from "./native-snowflake-http.js";
import { zodJitless } from "./zod-jitless.js";

zodJitless();
const PUBLIC = ["account_url", "token_type", "role"];
const PRIVATE = ["token"];
const tokenType = z.enum(["PROGRAMMATIC_ACCESS_TOKEN", "OAUTH"]);
const tokenSchema = z
  .string()
  .min(1)
  .max(16384)
  .regex(/^[\x21-\x7e]+$/);
const roleSchema = z
  .string()
  .max(256)
  .refine((value) =>
    [...value].every(
      (character) =>
        character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127,
    ),
  );
function parseParameters(input: NativeApiConfigureInput) {
  try {
    return {
      account_url: snowflakeOrigin((input.parameters.account_url ?? "").trim()),
      token_type: tokenType.parse(
        input.parameters.token_type ?? "PROGRAMMATIC_ACCESS_TOKEN",
      ),
      role: roleSchema.parse(input.parameters.role ?? ""),
    };
  } catch {
    throw new Error(
      "Enter the Snowflake HTTPS account URL, supported token type and optional role.",
    );
  }
}
function validateInput(input: NativeApiConfigureInput) {
  if (
    input.providerId !== "snowflake" ||
    Object.keys(input.parameters).some((key) => !PUBLIC.includes(key)) ||
    Object.keys(input.credentials).some((key) => !PRIVATE.includes(key)) ||
    Object.keys(input.requestedScopes ?? {}).length ||
    Object.keys(input.targetIds ?? {}).length
  )
    throw new Error(
      "Configure only the Snowflake account URL, token type, role and token.",
    );
}
function parseTarget(
  input: NativeApiConfigureInput,
  saved: NativeConnectorRecord | null,
): SnowflakeTarget {
  validateInput(input);
  const parameters = parseParameters(input);
  const retain =
    saved?.configuration.providerId === input.providerId &&
    canonicalize(saved.configuration.parameters) === canonicalize(parameters);
  const token =
    input.credentials.token ||
    (retain ? saved.privateState.credentials.token : "") ||
    "";
  if (!tokenSchema.safeParse(token).success)
    throw new Error(
      "Enter a token for this exact Snowflake account, token type and role.",
    );
  const credentials = { token };
  const exposed = { token, encoded: encodeURIComponent(token) };
  safeProviderText(input.displayName, exposed);
  safeNativeConnectorIcon(input.icon ?? "", exposed);
  for (const value of Object.values(parameters))
    safeProviderText(value, exposed);
  const target: SnowflakeTarget = {
    providerId: "snowflake",
    parameters,
    credentials,
  };
  if (saved)
    target.binding = {
      id: saved.connectionId,
      revision: saved.revision,
      fingerprint: saved.configuration.fingerprint,
    };
  return target;
}
export function nativeSnowflakeUi(): NativeKeyUi {
  return {
    name: "Snowflake",
    methodLabel: "Snowflake token",
    instructions:
      "Copy the HTTPS Server URL from Snowsight Account Details. Supply a restricted programmatic access token or an already-issued OAuth access token. Verification runs SHOW TERSE DATABASES LIMIT 20 without a warehouse. Requests use this account only, through the approved browser or configured native HTTP route. Polling is bounded; authority loss stops local requests. Snowflake's 15-second statement timeout bounds the read-only job; this connection does not remotely cancel it.",
    fields: [
      {
        id: "account_url",
        label: "Snowflake account URL",
        kind: "url",
        secret: false,
        required: true,
        placeholder: "https://organization-account.snowflakecomputing.com",
      },
      {
        id: "token_type",
        label: "Token type",
        kind: "choice",
        secret: false,
        required: true,
        defaultValue: "PROGRAMMATIC_ACCESS_TOKEN",
        choices: [
          {
            id: "PROGRAMMATIC_ACCESS_TOKEN",
            label: "Programmatic access token",
          },
          { id: "OAUTH", label: "Already-issued OAuth access token" },
        ],
      },
      {
        id: "role",
        label: "Role (optional)",
        kind: "text",
        secret: false,
        required: false,
        help: "Sent as structured request context, never inserted into SQL. Changing this role requires a token to be supplied and proved again.",
      },
      {
        id: "token",
        label: "Access token",
        kind: "text",
        secret: true,
        required: true,
      },
    ],
    links: [
      {
        label: "Snowflake SQL API authentication",
        url: "https://docs.snowflake.com/en/developer-guide/sql-api/authenticating",
      },
      {
        label: "Programmatic access tokens",
        url: "https://docs.snowflake.com/en/user-guide/programmatic-access-tokens",
      },
    ],
    disconnectExplanation:
      "Disconnect forgets this device's token and verified account. Revoke the token in Snowflake to end its other uses.",
    actions: [
      { id: "provider.databases.read", label: "List databases", fields: [] },
    ],
  };
}
export const snowflakeKeyFlows = createNativeKeyFlows<SnowflakeTarget>({
  family: "Snowflake",
  idPrefix: "conn_snowflake_",
  accepts: (providerId) => providerId === "snowflake",
  classification: { publicParameters: PUBLIC, privateCredentials: PRIVATE },
  ui: nativeSnowflakeUi,
  parse: parseTarget,
  fingerprint: async (target) => {
    const encoded = new TextEncoder().encode(
      canonicalize({
        contract: "snowflake-sql:databases:v1",
        providerId: target.providerId,
        parameters: target.parameters,
        credentials: target.credentials,
      }),
    );
    return [...new Uint8Array(await crypto.subtle.digest("SHA-256", encoded))]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
  },
  prove: async (target, transport) => {
    await readSnowflakeDatabases(target, transport);
    const origin = target.parameters.account_url ?? "";
    return {
      identity: {
        id: origin,
        label: new URL(origin).hostname,
        kind: "account",
      },
      targets: [{ id: origin, label: origin, kind: "account" }],
      grantLabel: "Snowflake database metadata access",
      target: { key: "account", id: origin },
    };
  },
  targetOf: (saved) =>
    parseTarget(
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
      id: "provider.databases.read",
      inputKeys: [],
      run: (target, transport) => readSnowflakeDatabases(target, transport),
    },
  ],
});
