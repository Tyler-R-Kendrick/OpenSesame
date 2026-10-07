import type { HostPeer, LogEntry, ReadField } from "./host-peer.js";
import type { Catalog } from "./messages.js";
import type { IceSettings, PeerFactory } from "./peer.js";
import type { Carrier } from "./rendezvous.js";
import type { LiveRoutes } from "./routes.js";

export type Admission = "invite" | "open";

export type GuestState = "asking" | "replied" | "joined" | "refused" | "gone";

export type Guest = Readonly<{
  /** The request id. */
  key: string;
  name: string;
  note: string;
  state: GuestState;
  askedAt: number;
  /** The reply code to hand back, once the owner has let them in. */
  reply: string | null;
}>;

export type HostState = Readonly<{
  status: "live" | "ended";
  endedBecause: "owner" | "expired" | null;
  guests: readonly Guest[];
  log: readonly LogEntry[];
  misses: number;
  /** Too many wrong codes: no new request is taken; the people in stay. */
  locked: boolean;
}>;

/** What pasting one request code did. */
export type Received =
  /** Not a request for this session, or one that has already closed. */
  | Readonly<{ kind: "not-a-request" }>
  | Readonly<{ kind: "not-this-session"; misses: number }>
  /** The session is locked: it takes no new request. */
  | Readonly<{ kind: "locked" }>
  | Readonly<{ kind: "full" }>
  | Readonly<{ kind: "ended" }>
  | Readonly<{ kind: "guest"; key: string }>;

export type HostOptions = Readonly<{
  admission: Admission;
  ice: IceSettings;
  /** Epoch ms; clamped to eight hours from now. */
  expiresAt: number;
  catalog: () => Catalog;
  readField: ReadField;
  /** Present when the session may write a shared field back. Absent denies. */
  writeField?: (
    item: string,
    field: string,
    value: string,
    ceiling?: () => void,
  ) => Promise<boolean>;
  peers: PeerFactory;
  /** What the link carries for joiners: ICE servers, relay only, carriers. */
  routes?: LiveRoutes;
  /** Where a reply code goes besides the owner's screen (a carrier). */
  post?: (code: string) => void;
  /**
   * A seat's channel on a carrier that may carry the session (NATS), or
   * null when none can; asked at each admission (ADR 0167).
   */
  relay?: (name: string) => Carrier | null;
  /** The link secret, when the caller minted credentials for its topic. */
  secret?: string;
  /** A production source pins its original vault key and scope here. */
  assertAuthority?: () => void;
  now?: () => number;
}>;

export type Seat = {
  guest: Guest;
  offer: string;
  /** The joiner's public key: its reply is sealed to it. */
  joiner: string;
  peer: HostPeer | null;
  /** An admit is waiting on its peer's answer: a second must not start. */
  admitting: boolean;
  carrier: Carrier | null;
  /** The seat's expiry while it waits, or its removal once it has ended. */
  timer: ReturnType<typeof setTimeout> | null;
};
