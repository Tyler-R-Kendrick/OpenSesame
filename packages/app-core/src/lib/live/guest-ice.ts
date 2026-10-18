/**
 * ICE progress while a joiner connects (P8-3): when connecting began, the
 * last diagnostic view seen, and the plain-language reason no route was
 * found. Split from `guest.ts` for the module-size budget (ADR 0093).
 */

import type { GuestStatus } from "./guest-types.js";
import {
  ICE_CANDIDATE_KINDS_EMPTY,
  type IceDiagnosticView,
  explainIceFailure,
} from "./ice-diagnostics.js";
import type { DialLink, PeerRouting } from "./p2p.js";

export class GuestIce {
  #since = 0;
  #last: IceDiagnosticView | null = null;
  #stop: (() => void) | null = null;

  constructor(
    private readonly routing: PeerRouting,
    private readonly now: () => number,
  ) {}

  /** Start watching a peer's ICE; `emit` reports each connecting status. */
  begin(
    peer: DialLink | null,
    emit: (status: GuestStatus) => void,
    connecting: () => boolean,
  ): void {
    this.stop();
    this.#since = this.now();
    emit({ at: "connecting", since: this.#since });
    if (!peer?.onIce) return;
    this.#stop = peer.onIce((view) => {
      this.#last = view;
      if (connecting()) {
        emit({ at: "connecting", since: this.#since, ice: view });
      }
    });
  }

  /** Why no route was found, from the routes agreed and the paths seen. */
  reason(timedOut: boolean): string {
    const kinds = this.#last?.candidates ?? ICE_CANDIDATE_KINDS_EMPTY;
    return explainIceFailure(this.routing, kinds, timedOut).message;
  }

  stop(): void {
    this.#stop?.();
    this.#stop = null;
  }
}
