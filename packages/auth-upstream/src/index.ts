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
  AuthenticationServiceError,
  DEFAULT_AUTHENTICATION_CONFIGURATIONS,
  authenticationApplicationSecretMatches,
  createAuthenticationService,
  hashAuthenticationToken,
  mintAuthenticationApplicationSecret,
  visibleAuthenticationAlias,
  type AuthenticationService,
  type AuthenticationSigninMode,
} from "./authentication-service.js";
export {
  generatePasskeyAuthenticationOptions,
  generatePasskeyRegistrationOptions,
  verifyPasskeyAuthentication,
  verifyPasskeyRegistration,
} from "./webauthn.js";
export { simpleWebAuthnSeams } from "./simplewebauthn.js";
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
  type MagicLinkMetadata,
  type MagicLinkRequestAccepted,
  type MagicLinkVerification,
  type SocialProviderConfig,
  type UpstreamAuth,
  type UpstreamAuthBundle,
  type UpstreamAuthDatabase,
  type UpstreamMagicLinkOptions,
} from "./better-auth.js";
