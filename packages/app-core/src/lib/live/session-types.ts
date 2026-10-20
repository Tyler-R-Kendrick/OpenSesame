/** Input contracts for the tab-owned hosted and joined live sessions. */
import type { Admission } from "./host.js";
import type { LiveLink } from "./link.js";
import type { SharePolicy } from "./messages.js";
import type { TransportFactory } from "./p2p.js";
import type { CarrierFactory } from "./rendezvous.js";
import type { LiveTransport } from "./transport.js";
import type { ShareScope } from "./vault-share.js";

export type HostInput = Readonly<{
  title: string;
  /** Who the generated link is for, for local identity/share provisioning. */
  provision?: Readonly<{
    audience: "anyone" | "all-users" | "people";
    peopleIds: readonly string[];
  }>;
  scope: ShareScope;
  policy: SharePolicy;
  admission: Admission;
  /** Minutes; the host clamps it to seven days. */
  minutes: number;
  /** The shell's transport (`p2p.ts`); WebRTC in Pages. */
  transport: TransportFactory;
  /** The owner's routes profile (Settings › Routes); direct when absent. */
  routes?: LiveTransport;
  /** The shell's carrier clients, for a profile that names carriers. */
  carriers?: CarrierFactory;
  /** Let devices ask to use the owner's connections (ADR 0196). */
  devices?: boolean;
}>;

export type JoinInput = Readonly<{
  link: LiveLink;
  code: string | null;
  name: string;
  note: string;
  /** The shell's transport (`p2p.ts`); WebRTC in Pages. */
  transport: TransportFactory;
  /**
   * Whether to use what the link names — its ICE servers and carriers. The
   * person agreed to the hosts it lists; without that, direct only.
   */
  useRoutes: boolean;
  carriers?: CarrierFactory;
  /** Optional OOB peer-trust signal (`peer-trust-peering.ts`); no daemon/CLI. */
  peerTrustSignal?: string | null;
  rememberedPeerFingerprint?: string;
  minimumPeerTrustEpoch?: number;
  /**
   * An unsigned manual-code join. Empty without this is refused.
   * The SAS compare is still required when the device can sign.
   */
  unverifiedManual?: boolean;
}>;
