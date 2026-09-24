/**
 * Per-request transport evidence for the Identity plane.
 *
 * A request's evidence is recorded by the dispatcher in `server.ts` before
 * any handler runs and is keyed by the `IncomingMessage` object in a
 * module-private WeakMap. Nothing in a header, query or body can write it;
 * `replayRequest` copies it explicitly via {@link adoptRequestEvidence} so the
 * buffered `/token` replay keeps exactly the evidence of the socket it came
 * from (AT-IDENTITY-SPLIT).
 *
 * The originating identity on the trusted-ingress profile is attached per
 * REQUEST, never per socket: two requests on one keep-alive ingress socket
 * carry independent evidence (AT-INGRESS-POOL).
 */
import type { IncomingMessage } from "node:http";
import type { TransportPolicy, VerifiedPeer } from "./peer-evidence.js";
import {
  type AdmissionResult,
  type BindingPurpose,
  type ServiceBindingSet,
  admitService,
} from "./service-admission.js";

export type ListenerProvenance =
  | { kind: "plain"; listener: string }
  | {
      kind: "tls";
      listener: string;
      policy: TransportPolicy;
      generation: number;
    };

export interface RequestEvidence {
  provenance: ListenerProvenance;
  /** The socket peer, when the handshake authenticated a client certificate. */
  peer?: VerifiedPeer;
  /** The originating client behind an authenticated ingress, this request only. */
  originating?: VerifiedPeer;
  /** Why originating evidence was refused, when the ingress forwarded some. */
  originatingError?: string;
  /** Resolve a service binding for this request (default deny). */
  admit(
    purpose: BindingPurpose,
    operation: string,
    now?: Date,
  ): AdmissionResult;
}

const evidence = new WeakMap<object, RequestEvidence>();

export interface RecordEvidenceInput {
  provenance: ListenerProvenance;
  peer?: VerifiedPeer;
  originating?: VerifiedPeer;
  originatingError?: string;
  bindings: ServiceBindingSet;
  clock?: () => Date;
}

/** Record evidence for a request. Called once, by the dispatcher. */
export function recordRequestEvidence(
  req: IncomingMessage,
  input: RecordEvidenceInput,
): RequestEvidence {
  const clock = input.clock ?? (() => new Date());
  const record: RequestEvidence = {
    provenance: input.provenance,
    admit(purpose, operation, now = clock()) {
      // Behind a trusted ingress the acting identity is the originating
      // client; the ingress leaf authenticates only the forwarding hop.
      const acting = input.originating ?? input.peer;
      if (!acting) {
        return {
          ok: false,
          code:
            input.provenance.kind === "plain"
              ? "listener_policy_mismatch"
              : input.originatingError
                ? "forwarded_evidence_unverified"
                : "peer_not_bound",
        };
      }
      return admitService(
        input.bindings,
        acting,
        purpose,
        operation,
        now,
        input.originating ? input.peer : undefined,
      );
    },
  };
  if (input.peer) record.peer = input.peer;
  if (input.originating) record.originating = input.originating;
  if (input.originatingError) record.originatingError = input.originatingError;
  evidence.set(req, record);
  return record;
}

/** The evidence recorded for a request, or none for one never dispatched. */
export function requestEvidenceOf(
  req: IncomingMessage | object | undefined,
): RequestEvidence | undefined {
  return req ? evidence.get(req) : undefined;
}

/** Copy evidence onto a replayed request object (same socket, same bytes). */
export function adoptRequestEvidence(
  replayed: IncomingMessage,
  original: IncomingMessage,
): void {
  const record = evidence.get(original);
  if (record) evidence.set(replayed, record);
}

/**
 * The peer whose certificate an access token must be bound to: the
 * originating client behind a trusted ingress, otherwise the direct peer.
 * Never the ingress leaf when an originating identity exists (AT-OAUTH-PROXY).
 */
export function bindingPeerOf(
  req: IncomingMessage | object | undefined,
): VerifiedPeer | undefined {
  const record = requestEvidenceOf(req);
  if (!record) return undefined;
  if (record.originating) return record.originating;
  // An ingress that forwarded evidence we could not verify must not fall
  // back to presenting its own leaf as the client.
  if (record.originatingError) return undefined;
  if (
    record.provenance.kind === "tls" &&
    record.provenance.policy === "trusted_ingress"
  ) {
    return undefined;
  }
  return record.peer;
}
