export type {
  AuthenticationIntent,
  PassiveOutcome,
  AmbientReasonCode,
  AmbientTransport,
  AmbientAuthMode,
} from "./types.js";
export { isAmbientIntent } from "./types.js";
export {
  defaultAmbientAuthPolicy,
  resolveAmbientAuthPolicy,
  readUserAmbientPreference,
  writeUserAmbientPreference,
  clearUserAmbientPreference,
  USER_AMBIENT_PREFERENCE_KEY,
  type AmbientAuthPolicy,
  type AmbientPolicyDecision,
} from "./policy.js";
export {
  providerConnectionKey,
  parseProviderConnectionKey,
  protocolForIssuer,
  capabilitiesForProtocol,
  supportsCapability,
  domainOnlyBrokerHint,
  normalizePrompt,
  type ProviderConnection,
} from "./provider.js";
export {
  parseAuthCallback,
  isAuthCallbackSearch,
  assertSafeReturnTo,
} from "./callback.js";
export {
  fenceLocalSignOut,
  clearAutoAuthSuppression,
  isAutoAuthSuppressed,
  currentAuthGeneration,
  matchesAuthGeneration,
  readAuthFence,
} from "./generation.js";
export {
  evaluateEligibility,
  startAutomaticAttempt,
  resetAmbientController,
  ambientControllerSeams,
  type Eligibility,
  type EligibilityInput,
  type ControllerState,
} from "./controller.js";
export {
  admitAmbientSession,
  ambientAdmissionSeams,
  vaultStateFromStore,
} from "./admission.js";
export { completeAmbientIfPresent } from "./complete.js";
export {
  beginAmbientOidc,
  exchangeAmbientCode,
  AMBIENT_SCOPES,
} from "./oidc.js";
export {
  entraRedirectBridgePath,
  acquireEntraSilent,
  entraSeams,
  ENTRA_SCOPES,
} from "./entra.js";
export {
  restoreAuthenticatedSession,
  readStoredSessionSync,
} from "./restoration.js";
export { applyAmbientReturn, ambientReturnSeams } from "./return-path.js";
export {
  cancelAllTransactions,
  inspectLegacyPending,
  legacyPendingUsableForAmbient,
} from "./transactions.js";
