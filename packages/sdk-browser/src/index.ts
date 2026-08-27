export { createOpenSesame } from "./client.js";
export { ClaimRequestError } from "./errors.js";
export {
  createAuthenticationClient,
  type AuthenticationClientConfig,
  type PasswordlessSignin,
} from "./authentication-service.js";
export {
  BrowserOriginError,
  OriginError,
  assertSafeReturnTo,
  canonicalizeBrowserOrigin,
  defaultOriginCallback,
  originProfileClientId,
} from "./origin.js";
export {
  createPkcePair,
  randomString,
  sha256Base64Url,
  base64UrlEncode,
} from "./pkce.js";
export type {
  ClaimDecision,
  ClaimPresentation,
  OidcDiscoveryDocument,
  OpenSesameBrowserClient,
  OpenSesameBrowserConfig,
  Session,
  StorageLike,
  TokenResponse,
} from "./types.js";
export {
  assertionPayload,
  authenticationResponseJson,
  b64urlToBytes,
  bytesToB64url,
  creationOptionsFromJson,
  isPublicKeyCredential,
  parsePublicKeyCredentialCreationOptionsJson,
  parsePublicKeyCredentialRequestOptionsJson,
  registrationResponseJson,
  requestOptionsFromJson,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
} from "./webauthn.js";
