import { truthy } from "./config-agent-providers.js";

export type ProtocolFeatures = {
  oid4vp: boolean;
  oid4vci: boolean;
  fedcm: boolean;
  digitalCredentialsApi: boolean;
  openidFederation: boolean;
  sdJwtVc: boolean;
  tokenStatusList: boolean;
  presentationAgentIntents: boolean;
};

/** Unset means on outside production; `false`/`0` opt out anywhere. */
function envEnabledOrDevDefault(
  value: string | undefined,
  isProduction: boolean,
): boolean {
  return value !== undefined ? truthy(value) : !isProduction;
}

export function loadProtocolFeatures(
  env: NodeJS.ProcessEnv,
  isProduction: boolean,
): ProtocolFeatures {
  return {
    // Unset means on outside production: required in-repo paths must work
    // under deterministic local configuration (ADR 0125). Production still
    // requires an explicit env opt-in. `false`/`0` opt out anywhere.
    oid4vp: envEnabledOrDevDefault(env.OPENSESAME_OID4VP_ENABLED, isProduction),
    oid4vci: envEnabledOrDevDefault(
      env.OPENSESAME_OID4VCI_ENABLED,
      isProduction,
    ),
    fedcm: truthy(env.OPENSESAME_FEDCM_ENABLED),
    digitalCredentialsApi: truthy(
      env.OPENSESAME_DIGITAL_CREDENTIALS_API_ENABLED,
    ),
    openidFederation: truthy(env.OPENSESAME_OPENID_FEDERATION_ENABLED),
    sdJwtVc: truthy(env.OPENSESAME_SD_JWT_VC_ENABLED),
    tokenStatusList: truthy(env.OPENSESAME_TOKEN_STATUS_LIST_ENABLED),
    presentationAgentIntents: truthy(
      env.OPENSESAME_PRESENTATION_AGENT_INTENTS_ENABLED,
    ),
  };
}
