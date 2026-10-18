/**
 * Value-blind ICE diagnostics for live peering (P8-3): candidate kinds and
 * plain-language failure reasons without exposing addresses.
 */

import type { PeerRouting } from "./p2p.js";

export type IcePhase =
  | "new"
  | "gathering"
  | "checking"
  | "connected"
  | "completed"
  | "failed"
  | "disconnected"
  | "closed";

export type IceCandidateKinds = Readonly<{
  host: number;
  srflx: number;
  relay: number;
  mdns: number;
}>;

export type IceDiagnosticView = Readonly<{
  phase: IcePhase;
  gathering: RTCIceGatheringState | "unknown";
  connection: RTCPeerConnectionState | "unknown";
  candidates: IceCandidateKinds;
  detail: string;
}>;

const EMPTY_KINDS: IceCandidateKinds = {
  host: 0,
  srflx: 0,
  relay: 0,
  mdns: 0,
};

/** Count candidate lines in SDP without retaining addresses. */
export function candidateKindsFromSdp(sdp: string): IceCandidateKinds {
  const kinds = { ...EMPTY_KINDS };
  for (const line of sdp.split(/\r?\n/)) {
    if (!line.startsWith("a=candidate:")) continue;
    const typ = line.match(/\btyp ([a-z0-9]+)\b/i)?.[1]?.toLowerCase();
    if (typ === "host") kinds.host += 1;
    else if (typ === "srflx") kinds.srflx += 1;
    else if (typ === "relay") kinds.relay += 1;
    if (/\b\.local\b/i.test(line)) kinds.mdns += 1;
  }
  return kinds;
}

export function mergeCandidateKinds(
  left: IceCandidateKinds,
  right: IceCandidateKinds,
): IceCandidateKinds {
  return {
    host: left.host + right.host,
    srflx: left.srflx + right.srflx,
    relay: left.relay + right.relay,
    mdns: left.mdns + right.mdns,
  };
}

function phaseFromPc(pc: RTCPeerConnection): IcePhase {
  switch (pc.connectionState) {
    case "new":
      return "new";
    case "connecting":
      return "checking";
    case "connected":
      return "connected";
    case "disconnected":
      return "disconnected";
    case "failed":
      return "failed";
    case "closed":
      return "closed";
    default:
      return "checking";
  }
}

function detailForPhase(
  phase: IcePhase,
  gathering: RTCIceGatheringState | "unknown",
  kinds: IceCandidateKinds,
): string {
  if (phase === "gathering" || gathering === "gathering")
    return "Gathering network paths";
  if (phase === "checking") return "Checking a route to the other browser";
  if (phase === "connected" || phase === "completed")
    return "Connected over a direct path";
  if (phase === "failed") return "ICE failed";
  return "Waiting for the browsers to meet";
}

/** Build a view from a peer connection and any SDP seen so far. */
export function iceViewFromPeer(
  pc: RTCPeerConnection,
  sdpParts: readonly string[],
): IceDiagnosticView {
  const gathered = sdpParts.reduce(
    (acc, sdp) => mergeCandidateKinds(acc, candidateKindsFromSdp(sdp)),
    { ...EMPTY_KINDS },
  );
  const gathering = pc.iceGatheringState ?? "unknown";
  const phase =
    gathering === "gathering" && pc.connectionState === "new"
      ? "gathering"
      : phaseFromPc(pc);
  return {
    phase,
    gathering,
    connection: pc.connectionState ?? "unknown",
    candidates: gathered,
    detail: detailForPhase(phase, gathering, gathered),
  };
}

export type IceFailureReason = Readonly<{
  code:
    | "no_route"
    | "mdns_only"
    | "relay_required"
    | "relay_missing"
    | "ice_failed"
    | "no_peer_route";
  message: string;
}>;

export function explainIceFailure(
  routing: PeerRouting,
  kinds: IceCandidateKinds,
  timedOut = false,
): IceFailureReason {
  if (routing.relay && kinds.relay === 0) {
    return {
      code: "relay_missing",
      message:
        "Relay only was required but no relay candidate appeared. Check the TURN server in Routes.",
    };
  }
  if (!routing.relay && routing.servers.length === 0) {
    const onlyMdns =
      kinds.host > 0 && kinds.mdns >= kinds.host && kinds.srflx === 0;
    if (onlyMdns) {
      return {
        code: "mdns_only",
        message:
          "No route found: both browsers only offered private or mDNS addresses. Add a tunnel address in Routes, use the same LAN, or add STUN/TURN you trust.",
      };
    }
    if (kinds.host === 0 && kinds.srflx === 0 && kinds.relay === 0) {
      return {
        code: "no_route",
        message: timedOut
          ? "No route found before the time limit. Check network paths or add a tunnel address in Routes."
          : "No route found between these browsers.",
      };
    }
    return {
      code: "no_route",
      message:
        "No route found: both browsers only offered private addresses. Add a STUN/TURN or tunnel address in Routes, or join from the same network.",
    };
  }
  if (routing.relay) {
    return {
      code: "relay_required",
      message: "Could not connect through the relay server named in Routes.",
    };
  }
  return {
    code: "ice_failed",
    message: timedOut
      ? "Connecting timed out before a route was found."
      : "The browsers could not find a route to each other.",
  };
}

export function unreachableMessage(reason: IceFailureReason): string {
  return reason.message;
}

export type IceListener = (view: IceDiagnosticView) => void;

/** Subscribe to ICE progress for one RTCPeerConnection. */
export function watchRtcIce(
  pc: RTCPeerConnection,
  listener: IceListener,
): () => void {
  const sdps: string[] = [];
  const push = () => {
    listener(iceViewFromPeer(pc, sdps));
  };
  const noteSdp = () => {
    const local = pc.localDescription?.sdp;
    const remote = pc.remoteDescription?.sdp;
    if (local) sdps.push(local);
    if (remote) sdps.push(remote);
    push();
  };
  pc.addEventListener("icegatheringstatechange", push);
  pc.addEventListener("iceconnectionstatechange", push);
  pc.addEventListener("connectionstatechange", push);
  pc.addEventListener("signalingstatechange", noteSdp);
  noteSdp();
  push();
  return () => {
    pc.removeEventListener("icegatheringstatechange", push);
    pc.removeEventListener("iceconnectionstatechange", push);
    pc.removeEventListener("connectionstatechange", push);
    pc.removeEventListener("signalingstatechange", noteSdp);
  };
}

export type IceWatcher = Readonly<{
  snapshot: () => IceDiagnosticView | null;
  stop: () => void;
}>;

/** One line for status marks and owner rows: phase plus candidate kinds. */
export function iceStatusLabel(view: IceDiagnosticView): string {
  const kinds: string[] = [];
  const { candidates } = view;
  if (candidates.host > 0) kinds.push(`${candidates.host} host`);
  if (candidates.srflx > 0) kinds.push(`${candidates.srflx} srflx`);
  if (candidates.relay > 0) kinds.push(`${candidates.relay} relay`);
  if (candidates.mdns > 0) kinds.push(`${candidates.mdns} mDNS`);
  const summary = kinds.length > 0 ? ` · ${kinds.join(", ")}` : "";
  return `${view.detail}${summary}`;
}

export const ICE_CANDIDATE_KINDS_EMPTY: IceCandidateKinds = {
  host: 0,
  srflx: 0,
  relay: 0,
  mdns: 0,
};
