import { readMockIdpConfig } from "./config.js";
import { createMockUpstreamIdp } from "./server.js";

export {
  createMockUpstreamIdp,
  type MintLogoutTokenOptions,
  type MintSamlResponseInput,
  type MockIdpObservations,
  type MockUpstreamIdp,
} from "./server.js";
export {
  readMockIdpConfig,
  createMockIdpKeys,
  createMockIdpSamlKeys,
  assertMockIdpListenAllowed,
  type MockIdpClientMode,
  type MockIdpConfig,
  type MockIdpOAuth2Config,
  type MockIdpSamlKeys,
} from "./config.js";
export {
  OAUTH2_AUTHORIZE_PATH,
  OAUTH2_METADATA_PATH,
  OAUTH2_TOKEN_PATH,
  OAUTH2_USERINFO_PATH,
  oauth2Urls,
} from "./oauth2.js";
export {
  NAMEID_FORMAT_EMAIL,
  NAMEID_FORMAT_PERSISTENT,
  SAML_METADATA_PATH,
  SAML_SSO_PATH,
  type SamlMutation,
} from "./saml.js";
export {
  startReferenceIdp,
  type IdpInitiatedSamlOptions,
  type IdpInitiatedSamlPost,
  type ReferenceIdp,
  type ReferenceIdpClientMode,
  type ReferenceIdpOAuth2,
  type ReferenceIdpOptions,
  type ReferenceIdpProtocol,
  type ReferenceIdpSaml,
  type ReferenceIdpTokenClient,
} from "./testkit.js";

export async function main(): Promise<void> {
  const config = readMockIdpConfig();
  const idp = await createMockUpstreamIdp(config);
  const issuer = await idp.listen();
  console.log(`@opensesame/mock-upstream-idp listening at ${issuer}`);
  console.log(`  discovery: ${issuer}/.well-known/openid-configuration`);
  console.log(`  saml metadata: ${issuer}/saml/metadata`);
  console.log(`  oauth2 authorize: ${issuer}/login/oauth/authorize`);
  console.log(`  seed client: ${config.clientId}`);
  console.log(`  test user: ${config.testUser.sub} <${config.testUser.email}>`);

  const shutdown = async () => {
    await idp.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}
