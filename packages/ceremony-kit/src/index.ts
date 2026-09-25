/**
 * Ceremony logic shared by every surface that runs one: the standalone
 * ceremonies app (ADR 0045), the Pages vault app dogfooding the same flows,
 * the console, mobile MFA, and the CLIs.
 *
 * Pure logic only — no React, no storage of its own, no ambient `fetch`. Each
 * surface passes in the pieces that differ: the ceremonies app resolves its
 * Identity API at build time, Pages resolves it at runtime from user settings,
 * and the two disagree about which storage a bearer may touch. Following the
 * `@opensesame/qr` convention, the logic is shared here and each app keeps its
 * own JSX.
 *
 * Cross-device interaction links (ADR 0086) are built, parsed, driven and
 * rendered here and nowhere else. Four apps used to hold four private copies
 * of that knowledge, which meant four link formats, four expiry stories, and
 * four independent chances to put a bearer in a URL.
 */

export {
  type AuthenticatorInvocation,
  AuthenticatorInvocationError,
  parseAuthenticatorInvocation,
} from "./authenticator-invocation.js";
export {
  AUTHENTICATOR_INVOCATION_KINDS,
  type AuthenticatorInvocationKind,
  CEREMONY_ROUTES,
  type CeremonyRoute,
  type CeremonyRouteId,
  ceremonyPath,
  ceremonyRouterPath,
  ceremonyRoutePrefix,
  type InvokeKind,
  invokeKind,
  isAuthenticatorInvocationKind,
  LEGACY_LINKS,
  type LegacyLinks,
  type LegacyLinkShape,
  matchCeremonyPath,
} from "./ceremony-routes.js";
export {
  parseUserCode,
  readFragmentToken,
  scrubFragment,
} from "./deep-link.js";
export {
  type ClaimStash,
  type ClaimStashOptions,
  createClaimStash,
  type StashStorage,
} from "./claim-stash.js";
export {
  type ClaimLink,
  fragmentCarriesBearer,
  isClaimToken,
  readClaimLink,
} from "./claim-link.js";
export {
  type ClaimRefusal,
  type ClaimRefusalKind,
  claimRefusal,
  type DropRefusal,
  type DropRefusalCode,
  dropRefusal,
} from "./claim-words.js";
export {
  approveDevice,
  type ApproveDeviceInput,
  CeremonyRequestError,
  type DeviceApproval,
  deviceApprovalWords,
} from "./device.js";
export {
  assertNoForbiddenParams,
  buildInteractionUrl,
  InteractionLinkError,
  type InteractionLinkErrorReason,
  isInteractionRef,
  type LegacyInteractionLink,
  parseInteractionUrl,
  parseLegacyInteractionLink,
} from "./interaction-url.js";
export {
  type ApproveInteractionInput,
  type BeginInteractionActivationInput,
  type CompleteInteractionActivationInput,
  createInteractionClient,
  type DenyInteractionInput,
  type InteractionActivationChallenge,
  type InteractionActivationResult,
  type InteractionClient,
  type InteractionClientOptions,
} from "./interaction-client.js";
export {
  INTERACTION_ERROR_WORDS,
  InteractionError,
  type InteractionErrorCode,
} from "./interaction-error.js";
export {
  type ApprovalView,
  chooseMechanism,
  INTERACTION_LABELS,
  INTERACTION_WORDS,
  interactionRefusal,
  type InteractionRefusal,
  type InteractionRefusalKind,
  type Mechanism,
  type Outcome,
  OUTCOME_IS_REFUSAL,
  OUTCOME_MARK,
  OUTCOME_TEXT,
  outcomeOfErrorCode,
  outcomeOfStatus,
  viewOf,
} from "./interaction-outcome.js";
export {
  createInteractionApproval,
  type InteractionApproval,
  type InteractionApprovalDeps,
  type InteractionAssertion,
  type InteractionAuthenticator,
  type InteractionPhase,
  type InteractionStep,
  InteractionStepUpError,
  STEP_UP_WORDS,
  type StepUpFailure,
} from "./interaction-approval.js";
export {
  type InteractionArrival,
  type InteractionArrivalRead,
  readInteractionArrival,
} from "./interaction-arrival.js";
export {
  type ApprovalArrival,
  type ApprovalArrivalRead,
  approvalRefAt,
  isApprovalRef,
  readApprovalArrival,
} from "./approval-link.js";
export {
  renderInteractionSummary,
  type RenderedInteractionSummary,
} from "./interaction-summary.js";
export {
  APPROVAL_LABELS,
  APPROVAL_WORDS,
  type ApprovalAssurance,
  arrivedViaSentence,
  assuranceSummary,
  type AuthorizationDetailView,
  CHANNEL_NAMES,
  channelKindOf,
  channelLabel,
  channelName,
  describeDetail,
  needsCeremony,
  requirementSentence,
  requirementSentences,
  riskSentence,
} from "./approval-copy.js";
export {
  ApprovalError,
  type ApprovalRefusal,
  type ApprovalRefusalKind,
  approvalRefusal,
  approvalWords,
  COMPARISON_MISMATCH,
} from "./approval-words.js";
export {
  type ApprovalActivationChallenge,
  type ApprovalRequirement,
  type ApprovalVerb,
  type AuthorizationRequestClient,
  type AuthorizationRequestClientOptions,
  type AuthorizationRequestView,
  createAuthorizationRequestClient,
  readAuthorizationRequest,
  type SettleInput,
} from "./authorization-request-client.js";
export {
  type ApprovalEnding,
  type ApprovalPhase,
  type ApprovalReview,
  type ApprovalReviewDeps,
  type ApprovalStep,
  createApprovalReview,
  type DecisionInput,
} from "./approval-review.js";
