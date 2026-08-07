export {
  MemoryPrincipalMappingStore,
  type PrincipalMapping,
  type PrincipalMappingStore,
} from "./mapping.js";
export {
  createProvisionalPrincipal,
  upgradeProvisionalToUpstream,
  type ProvisionalSession,
  type CreateProvisionalOptions,
  type UpgradeToUpstreamInput,
} from "./provisional.js";
export { noEmailAutoLinkPolicy, type EmailLinkPolicy } from "./email-link.js";
export {
  createPasskeySeam,
  type PasskeyAssertion,
  type PasskeyCredential,
  type PasskeySeam,
  type PasskeyVerifyFn,
} from "./passkey.js";
export {
  createMemoryChallengeStore,
  createSimpleWebAuthnVerifyFn,
  issueAuthenticationChallenge,
  type PasskeyChallengeStore,
  type WebAuthnRpConfig,
} from "./webauthn.js";
export {
  UpstreamOidcProviderRegistry,
  mockUpstreamProvider,
  type UpstreamOidcProvider,
} from "./oidc-registry.js";
export {
  createUpstreamAuth,
  type CreateUpstreamAuthOptions,
  type UpstreamAuthBundle,
} from "./better-auth.js";
