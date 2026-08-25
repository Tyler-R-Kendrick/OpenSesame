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
  type PasskeyVerifyResult,
} from "./passkey.js";
export {
  createMemoryChallengeStore,
  createSimpleWebAuthnVerifyFn,
  issueAuthenticationChallenge,
  issueRegistrationChallenge,
  verifyRegistrationAttestation,
  type PasskeyChallengeStore,
  type VerifiedRegistration,
  type WebAuthnRpConfig,
} from "./webauthn.js";
export {
  UpstreamOidcProviderRegistry,
  mockUpstreamProvider,
  type UpstreamOidcProvider,
} from "./oidc-registry.js";
export {
  createUpstreamAuth,
  type BetterAuthUser,
  type CreateUpstreamAuthOptions,
  type MagicLinkDelivery,
  type MagicLinkVerification,
  type UpstreamAuth,
  type UpstreamAuthBundle,
  type UpstreamMagicLinkOptions,
} from "./better-auth.js";
