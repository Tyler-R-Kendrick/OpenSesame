import {
  type BoundaryValue,
  isJsonObject,
  isString,
} from "@opensesame/os-domain";
import {
  authenticationResponseJson,
  creationOptionsFromJson,
  isPublicKeyCredential,
  parsePublicKeyCredentialCreationOptionsJson,
  parsePublicKeyCredentialRequestOptionsJson,
  registrationResponseJson,
  requestOptionsFromJson,
} from "./webauthn.js";

export type PasswordlessSignin = (
  | { mode: "autofill" | "discoverable" }
  | { mode: "alias"; alias: string }
  | { mode: "user_id"; userId: string }
) & { purpose?: string };

export interface AuthenticationClientConfig {
  apiBase: string;
  applicationId: string;
  fetchImpl?: typeof fetch;
  credentials?: Pick<CredentialsContainer, "create" | "get">;
}

async function jsonResponse(response: Response): Promise<BoundaryValue> {
  const body: BoundaryValue = await response.json().catch(() => null);
  if (!response.ok) {
    const error =
      isJsonObject(body) && isString(body.error)
        ? body.error
        : `authentication_request_failed_${response.status}`;
    throw new Error(error);
  }
  return body;
}

export function createAuthenticationClient(config: AuthenticationClientConfig) {
  const fetchImpl = config.fetchImpl ?? fetch;
  const credentials = config.credentials ?? navigator.credentials;
  const endpoint = (path: string) =>
    `${config.apiBase.replace(/\/+$/, "")}/v1/authentication/public${path}`;
  const post = <Body extends object>(path: string, body: Body) =>
    fetchImpl(endpoint(path), {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "omit",
      body: JSON.stringify(body),
    });

  return {
    async register(registrationToken: string, name?: string) {
      const raw = await jsonResponse(
        await post("/register/options", {
          applicationId: config.applicationId,
          token: registrationToken,
        }),
      );
      const parsed = parsePublicKeyCredentialCreationOptionsJson(raw);
      if (!parsed) throw new Error("invalid_registration_options");
      const created = await credentials.create(creationOptionsFromJson(parsed));
      if (!created || !isPublicKeyCredential(created)) {
        throw new Error("passkey_registration_cancelled");
      }
      return jsonResponse(
        await post("/register/verify", {
          applicationId: config.applicationId,
          response: registrationResponseJson(created),
          ...(name ? { name } : undefined),
        }),
      );
    },

    async signin(input: PasswordlessSignin) {
      const raw = await jsonResponse(
        await post("/signin/options", {
          applicationId: config.applicationId,
          ...input,
        }),
      );
      const parsed = parsePublicKeyCredentialRequestOptionsJson(raw);
      if (!parsed) throw new Error("invalid_authentication_options");
      const mediation: CredentialMediationRequirement = "conditional";
      const requested = await credentials.get({
        ...requestOptionsFromJson(parsed),
        ...(input.mode === "autofill" ? { mediation } : undefined),
      });
      if (!requested || !isPublicKeyCredential(requested)) {
        throw new Error("passkey_authentication_cancelled");
      }
      const result = await jsonResponse(
        await post("/signin/verify", {
          applicationId: config.applicationId,
          response: authenticationResponseJson(requested),
        }),
      );
      if (
        !isJsonObject(result) ||
        !isString(result.token) ||
        !isString(result.expiresAt)
      ) {
        throw new Error("invalid_authentication_result");
      }
      return { token: result.token, expiresAt: result.expiresAt };
    },
  };
}
