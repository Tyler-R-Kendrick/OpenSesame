import type { Admission } from "./host.js";
import type { SharePolicy } from "./messages.js";
import type { PeerFactory } from "./peer.js";
import type { CarrierFactory, Rendezvous } from "./rendezvous.js";
import type { LiveTransport } from "./transport.js";
import type { ShareScope } from "./vault-share.js";

export type HostInput = Readonly<{
  title: string;
  scope: ShareScope;
  policy: SharePolicy;
  admission: Admission;
  /** Minutes; the host clamps it to eight hours. */
  minutes: number;
  peers: PeerFactory;
  /** The owner's transport profile; direct only when absent. */
  transport?: LiveTransport;
  /** A narrowing ceiling while the original configured session is being built. */
  assertConfiguration?: () => void;
  /** The shell's carrier clients, for a profile that names carriers. */
  carriers?: CarrierFactory;
}>;

/** Where an admission asks for a seat's relay, once the carriers are open. */
export type RelaySource = { carriers: Rendezvous | null };
