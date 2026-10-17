/**
 * Join-screen peer trust: pin a remembered key, or block when it changed.
 */
import { liveJoinAskDisabledReason } from "@opensesame/app-core/lib/live/form-disabled-reason.js";
import type { LiveLink } from "@opensesame/app-core/lib/live/link.js";
import {
  readSignalIdentity,
  rememberedPeerPin,
} from "@opensesame/app-core/lib/peer-trust/peers.js";

export type JoinTrustFields = Readonly<{
  blocked: string;
  peerTrustSignal: string | null;
  unverifiedManual: boolean;
  rememberedPeerFingerprint?: string;
  minimumPeerTrustEpoch?: number;
}>;

const OPEN: JoinTrustFields = {
  blocked: "",
  peerTrustSignal: null,
  unverifiedManual: true,
};

type PinFields = Readonly<{ fingerprint: string; epoch: number }>;

function trustRow(
  signal: string,
  blocked: string,
  pin: PinFields | null,
): JoinTrustFields {
  const row: JoinTrustFields = {
    blocked,
    peerTrustSignal: signal,
    unverifiedManual: false,
  };
  if (!pin) return row;
  return {
    ...row,
    rememberedPeerFingerprint: pin.fingerprint,
    minimumPeerTrustEpoch: pin.epoch,
  };
}

export async function joinTrustFields(
  signal: string,
): Promise<JoinTrustFields> {
  if (signal.length === 0) return OPEN;
  const identity = readSignalIdentity(signal);
  if (!identity) return trustRow(signal, "", null);
  try {
    const pin = await rememberedPeerPin(identity.fingerprint);
    if (pin.kind === "mismatch") {
      return trustRow(signal, "This peer's key changed", pin);
    }
    if (pin.kind === "known") return trustRow(signal, "", pin);
  } catch {
    // No peer store yet: the signal is still checked when the join starts.
  }
  return trustRow(signal, "", null);
}

export function joinAskDisabledReason(input: {
  alarm: string;
  ready: boolean;
  busy: boolean;
  link: LiveLink | null;
  pasted: string;
  needsCode: boolean;
  code: string;
  name: string;
}): string | undefined {
  if (input.alarm) return input.alarm;
  if (input.ready || input.busy) return undefined;
  return liveJoinAskDisabledReason({
    link: input.link,
    pasted: input.pasted,
    needsCode: input.needsCode,
    code: input.code,
    name: input.name,
    busy: input.busy,
  });
}

export function liveTrustRefusal(error: Error): string | null {
  if (!error.message.startsWith("peer_trust_refused:")) return null;
  if (error.message.endsWith(":changed-key")) return "This peer's key changed";
  if (error.message.endsWith(":missing-signal")) {
    return "Peer trust signal is required";
  }
  return "Peer trust could not be verified";
}
