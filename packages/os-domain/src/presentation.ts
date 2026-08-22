import type { AssuranceRequirement } from "./trust.js";
export type PresentationState =
  | "created"
  | "request_validated"
  | "credentials_matched"
  | "consent_required"
  | "consented"
  | "activation_required"
  | "activated"
  | "signed"
  | "delivered"
  | "completed"
  | "denied"
  | "expired"
  | "revoked"
  | "failed";
export interface PresentationSession {
  id: string;
  protocol: "openid4vp" | "digital_credentials_api" | "internal";
  principalId?: string;
  verifierId: string;
  verifierOrigin?: string;
  clientId?: string;
  requestObjectDigest: string;
  nonceDigest: Uint8Array;
  responseUri?: string;
  requestedClaims: string[];
  purpose: string;
  assuranceRequirement: AssuranceRequirement;
  state: PresentationState;
  createdAt: Date;
  expiresAt: Date;
  consentedAt?: Date;
  activatedAt?: Date;
  completedAt?: Date;
  version: number;
}
export interface PresentationConsent {
  id: string;
  presentationId: string;
  principalId: string;
  verifierId: string;
  requestObjectDigest: string;
  approvedClaims: string[];
  purpose: string;
  rememberDecision: boolean;
  grantedAt: Date;
  expiresAt?: Date;
  revokedAt?: Date;
  version: number;
}
export interface PresentationIntent {
  id: string;
  principalId: string;
  requesterAgentId: string;
  verifierId: string;
  verifierOrigin?: string;
  requestedClaims: string[];
  purpose: string;
  assuranceRequirement: AssuranceRequirement;
  requestDigest: string;
  createdAt: Date;
  expiresAt: Date;
}
export interface PresentationRef {
  id: string;
  requestDigest: string;
}
export interface PresentationReceipt {
  id: string;
  presentationId: string;
  requestDigest: string;
  outcome: "completed" | "denied" | "failed";
  claimNames: string[];
  issuerIds: string[];
  completedAt: Date;
}
