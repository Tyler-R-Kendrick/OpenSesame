/**
 * What the background's fill flow needs from the browser and the daemon,
 * as ports, so the flow runs in a test exactly as it runs in the service
 * worker (`browser-ports.ts` binds the real ones).
 */
import type { ArmLedger, SenderFacts } from "./admit";
import { type DaemonClient, FillError, type KeyValueStore } from "./daemon";
import type { ArmMessage, GuardReply } from "./wire";

export interface ActiveTab {
  readonly id: number;
  readonly url?: string;
}

/** The tab a person is looking at, when it holds a web page. */
export interface Page {
  readonly tab: ActiveTab;
  readonly origin: string;
}

/** The part of the site registry the flow consults. */
export interface SiteSwitch {
  isEnabled(origin: string): Promise<boolean>;
  enable(origin: string): Promise<string>;
  disable(origin: string): Promise<void>;
}

export interface FillPorts {
  /** This extension's id, as the browser reports it on a sender. */
  readonly ownId: string;
  /** The URL prefix of this extension's own pages. */
  readonly ownBase: string;
  activeTab(): Promise<ActiveTab | null>;
  /** Inject the guard into frame 0 when the registered one is not there. */
  inject(tabId: number): Promise<void>;
  /** Message frame 0 of `tabId`, decoded; rejects when no guard listens. */
  send(tabId: number, message: ArmMessage): Promise<GuardReply>;
  readonly sites: SiteSwitch;
  readonly daemon: DaemonClient;
  /** The reference a person last chose per origin, for this session only. */
  readonly choices: KeyValueStore;
  now(): number;
  nonce(): string;
}

/** What the background knows about a runtime message's sender. */
export interface RuntimeSender extends SenderFacts {
  /** Present when the sender is a page's content script. */
  readonly tab?: { readonly id?: number };
  readonly url?: string;
}

/** The ports and the one ledger of armed gestures, shared by every step. */
export interface Flow {
  readonly ports: FillPorts;
  readonly ledger: ArmLedger;
}

/** A daemon refusal's code; anything else means the daemon did not answer. */
export const codeOf = (cause: unknown): string =>
  cause instanceof FillError ? cause.code : "daemon_unreachable";
