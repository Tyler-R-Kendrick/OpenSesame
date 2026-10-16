export {
  compareRootTrustFingerprint,
  type RootTrustAlarm,
} from "./alarm.js";
export { ensurePeerArkSigningKey, type PeerArkSigningKey } from "./ark-key.js";
export {
  PeerApprovalQueue,
  type PeerEnsureResult,
  type PeerEnsureStatus,
} from "./approval-queue.js";
export {
  PEER_TRUST_ENVELOPE_KIND,
  PEER_TRUST_SIGNAL_KIND,
} from "./constants.js";
export {
  peerTrustSignedBytes,
  signPeerTrustEnvelope,
  verifyPeerTrustEnvelope,
  type SignedPeerTrustEnvelope,
} from "./envelope.js";
export {
  exportSpkiB64,
  fingerprintOfSpki,
  fingerprintOfSpkiB64,
} from "./fingerprint.js";
export {
  humanProofKindAllowsVerb,
  softwarePasskeyAllowedForVerb,
  verbRequiresHardwarePasskey,
} from "./human-proof-tier.js";
export {
  nextEnrollmentEpoch,
  parsePeerTrustRecord,
  type PeerTrustRecord,
} from "./record.js";
export { sasFromFingerprint } from "./sas.js";
export {
  buildPeerTrustSignal,
  decodePeerTrustSignal,
  encodePeerTrustSignal,
  verifyPeerTrustSignal,
  type PeerTrustSignal,
} from "./signaling.js";
export {
  commitPeerTrustEnrollment,
  loadPeerTrustStore,
  type PeerTrustCommitResult,
  type PeerTrustLoadResult,
} from "./store.js";
