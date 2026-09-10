/** No Better Auth, Node adapters, storage, or server session authority. */
export {
  verifyPasskeyAuthentication,
  verifyPasskeyRegistration,
  type VerifiedRegistration,
  type WebAuthnRpConfig,
} from "./passkey-verification.js";
export type {
  AuthenticationResponseJSON,
  RegistrationResponseJSON,
} from "@simplewebauthn/server";
