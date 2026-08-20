import {
  type ClientAdmissionMode,
  type OAuthClientRecord,
  type OAuthProviderEnv,
  ORIGIN_PROFILE_FORBIDDEN_SCOPES,
} from "../types.js";
import { overlapCast } from "@opensesame/os-domain";

export class ClientAdmissionError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ClientAdmissionError";
    this.code = code;
  }
}

export interface ClientAdmissionPolicy {
  /** Whether a given admission mode is allowed under current env flags. */
  isModeEnabled(mode: ClientAdmissionMode): boolean;
  /** Validate a client record before it can participate in OAuth flows. */
  assertAdmissible(client: OAuthClientRecord): void;
  /** Origin-profile scope restrictions. */
  assertOriginScopes(scopes: string[]): void;
}

export function createClientAdmissionPolicy(
  env: Pick<
    OAuthProviderEnv,
    "originClientsEnabled" | "dcrEnabled" | "cimdEnabled"
  >,
): ClientAdmissionPolicy {
  return {
    isModeEnabled(mode: ClientAdmissionMode): boolean {
      switch (mode) {
        case "pre_registered":
          return true;
        case "origin_profile":
          return env.originClientsEnabled;
        case "dynamic_registration":
          return env.dcrEnabled;
        case "client_metadata_document":
          return env.cimdEnabled;
        default: {
          const _exhaustive: never = mode;
          return _exhaustive;
        }
      }
    },

    assertAdmissible(client: OAuthClientRecord): void {
      if (client.state !== "active") {
        throw new ClientAdmissionError(
          "client_inactive",
          `Client ${client.id} is ${client.state}`,
        );
      }
      if (!this.isModeEnabled(client.admissionMode)) {
        throw new ClientAdmissionError(
          "admission_mode_disabled",
          `Client admission mode "${client.admissionMode}" is disabled`,
        );
      }
      if (client.admissionMode === "origin_profile") {
        this.assertOriginScopes(client.allowedScopes);
        if (client.grantTypes.includes("client_credentials")) {
          throw new ClientAdmissionError(
            "origin_forbidden_grant",
            "Origin-profile clients may not use client_credentials",
          );
        }
        if (!client.origin) {
          throw new ClientAdmissionError(
            "origin_required",
            "Origin-profile clients require an origin",
          );
        }
      }
    },

    assertOriginScopes(scopes: string[]): void {
      for (const scope of scopes) {
        if (
          (overlapCast(ORIGIN_PROFILE_FORBIDDEN_SCOPES)).includes(scope)
        ) {
          throw new ClientAdmissionError(
            "origin_forbidden_scope",
            `Origin-profile clients may not request scope "${scope}"`,
          );
        }
      }
    },
  };
}

/** Defaults: pre_registered only; origin/DCR/CIMD off unless env enables them. */
export function defaultAdmissionFromEnv(
  env: OAuthProviderEnv,
): ClientAdmissionPolicy {
  return createClientAdmissionPolicy(env);
}
