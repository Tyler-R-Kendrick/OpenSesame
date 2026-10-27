import type { ManageGrants } from "../proofs/share-write.js";
import { domainMatchScore } from "../site-broker.js";
import type { DeviceReply } from "./device-messages.js";
import {
  type DeviceResetGrant,
  type DeviceResetRequest,
  type DeviceResetStatus,
  resetRequestDigest,
} from "./device-reset-messages.js";
import {
  NO_RESET_DEVICES,
  type PendingReset,
  RESET_ASK_TTL_MS,
  RESET_GRANT_TTL_MS,
  type ResetDevicesState,
  type ResetGrant,
  type ResetGrantRecord,
  type ResetItem,
  type ResetPendingRecord,
  type ResetSeat,
  type ResetSeatDevices,
} from "./device-reset-types.js";
import type { ApproveResult, SeatIdentity } from "./device-types.js";
import { newRequestId } from "./seal.js";

export type ResetBrokerOptions = Readonly<{
  items: () => readonly ResetItem[];
  expiresAt: number;
  now?: () => number;
  changed: () => void;
}>;

const METADATA = "password_reset.domain_metadata.list";

export class DeviceResetBroker {
  readonly #options: ResetBrokerOptions;
  readonly #seats = new Map<string, ResetSeat>();
  readonly #now: () => number;
  #over = false;

  constructor(options: ResetBrokerOptions) {
    this.#options = options;
    this.#now = options.now ?? Date.now;
  }

  get state(): ResetDevicesState {
    if (this.#seats.size === 0) return NO_RESET_DEVICES;
    const pending: PendingReset[] = [];
    const grants: ResetGrant[] = [];
    for (const seat of this.#seats.values()) {
      if (seat.pending?.outcome === "waiting")
        pending.push(this.#pendingView(seat.pending));
      for (const grant of seat.grants.values())
        grants.push(this.#grantView(grant));
    }
    return {
      pending: pending.sort((a, b) => a.askedAt - b.askedAt),
      grants: grants.sort((a, b) => a.grantedAt - b.grantedAt),
    };
  }

  #pendingView(wait: ResetPendingRecord): PendingReset {
    return this.#view(wait, {
      id: wait.id,
      seat: wait.seat.identity.key,
      name: wait.seat.identity.name,
      itemName: wait.itemName,
      askedAt: wait.askedAt,
    });
  }

  #grantView(grant: ResetGrantRecord): ResetGrant {
    return {
      ...this.#view(grant, {
        id: grant.id,
        seat: grant.seat.identity.key,
        name: grant.seat.identity.name,
        itemName: grant.itemName,
        grantedAt: grant.grantedAt,
      }),
      humanStatus: grant.humanStatus,
    };
  }

  #view<T extends object>(
    record: ResetPendingRecord | ResetGrantRecord,
    extra: T,
  ) {
    return {
      origin: record.origin,
      item: record.item,
      runtime: record.runtime,
      model: record.model,
      expiresAt: record.expiresAt,
      actions: record.actions,
      digest: record.digest,
      ...extra,
    };
  }

  seat(
    identity: SeatIdentity,
    send: (reply: DeviceReply) => void,
  ): ResetSeatDevices {
    const seat: ResetSeat = {
      identity,
      send,
      pending: null,
      grants: new Map(),
    };
    if (!this.#over) this.#seats.set(identity.key, seat);
    return {
      handle: (request) => this.#handle(seat, request),
      close: () => this.#leave(seat),
    };
  }

  async #handle(
    seat: ResetSeat,
    request: DeviceResetRequest | DeviceResetStatus,
  ) {
    if (this.#over || this.#seats.get(seat.identity.key) !== seat) return;
    if (request.t === "dev.reset.status") return this.#status(seat, request);
    await this.#ask(seat, request);
  }

  async #ask(seat: ResetSeat, request: DeviceResetRequest): Promise<void> {
    if (seat.pending) {
      seat.send({ t: "dev.error", req: request.req, error: "invalid_request" });
      return;
    }
    const now = this.#now();
    const latest = Math.min(now + RESET_GRANT_TTL_MS, this.#options.expiresAt);
    if (request.expiresAt <= now || request.expiresAt > latest) {
      seat.send({ t: "dev.error", req: request.req, error: "expired_token" });
      return;
    }
    if ((await resetRequestDigest(request)) !== request.digest) {
      seat.send({ t: "dev.error", req: request.req, error: "invalid_request" });
      return;
    }
    const metadata = request.actions[0] === METADATA;
    const item = metadata ? null : this.#item(request.item, request.origin);
    if (!metadata && !item) {
      seat.send({ t: "dev.error", req: request.req, error: "access_denied" });
      return;
    }
    const pending: ResetPendingRecord = {
      ...request,
      id: newRequestId(),
      seat,
      itemName: item?.name ?? new URL(request.origin).hostname,
      askedAt: now,
      askExpiresAt: Math.min(now + RESET_ASK_TTL_MS, request.expiresAt),
      outcome: "waiting",
      timer: null,
    };
    pending.timer = setTimeout(
      () => this.#lapse(pending),
      Math.max(0, pending.askExpiresAt - now),
    );
    seat.pending = pending;
    this.#options.changed();
  }

  #matches(item: ResetItem, origin: string): boolean {
    return item.origins.some((entry) => domainMatchScore(origin, entry) > 0);
  }

  #item(id: string, origin: string): ResetItem | null {
    return (
      this.#options
        .items()
        .find((item) => item.id === id && this.#matches(item, origin)) ?? null
    );
  }

  approve<Vault>(id: string, _authority: ManageGrants<Vault>): ApproveResult {
    const pending = this.#find(id);
    const now = this.#now();
    if (!pending || this.#over) return "unknown";
    if (pending.outcome !== "waiting" || now >= pending.askExpiresAt)
      return "lapsed";
    const metadata = pending.actions[0] === METADATA;
    if (!metadata && !this.#item(pending.item, pending.origin))
      return "unavailable";
    const { seat } = pending;
    const grant: ResetGrantRecord = {
      ...pending,
      id: `reset-${pending.req}`,
      grantedAt: now,
      humanStatus: null,
      timer: null,
    };
    grant.timer = setTimeout(
      () => this.#endGrant(grant),
      Math.max(0, grant.expiresAt - now),
    );
    seat.grants.set(grant.id, grant);
    pending.outcome = "approved";
    this.#settle(pending);
    const reply: DeviceResetGrant = {
      t: "dev.reset.grant",
      req: grant.req,
      grant: grant.id,
      origin: grant.origin,
      item: grant.item,
      runtime: grant.runtime,
      model: grant.model,
      expiresAt: grant.expiresAt,
      actions: grant.actions,
      digest: grant.digest,
    };
    if (metadata) {
      seat.send({
        ...reply,
        items: this.#options
          .items()
          .filter((item) => this.#matches(item, grant.origin)),
      });
    } else {
      seat.send(reply);
    }
    this.#options.changed();
    return "approved";
  }

  deny(id: string): boolean {
    const pending = this.#find(id);
    if (!pending || pending.outcome !== "waiting") return false;
    pending.outcome = "denied";
    pending.seat.send({
      t: "dev.error",
      req: pending.req,
      error: "access_denied",
    });
    this.#settle(pending);
    this.#options.changed();
    return true;
  }

  revoke(id: string): boolean {
    for (const seat of this.#seats.values()) {
      const grant = seat.grants.get(id);
      if (!grant) continue;
      this.#endGrant(grant);
      this.#options.changed();
      return true;
    }
    return false;
  }

  #status(seat: ResetSeat, request: DeviceResetStatus): void {
    const grant = seat.grants.get(request.grant);
    if (!grant || this.#now() >= grant.expiresAt) {
      seat.send({ t: "dev.error", req: request.req, error: "access_denied" });
      return;
    }
    grant.humanStatus = request.status;
    seat.send({ t: "dev.reset.ack", req: request.req });
    this.#options.changed();
  }

  #find(id: string): ResetPendingRecord | null {
    for (const seat of this.#seats.values())
      if (seat.pending?.id === id) return seat.pending;
    return null;
  }

  #lapse(pending: ResetPendingRecord): void {
    if (pending.seat.pending !== pending || pending.outcome !== "waiting")
      return;
    pending.outcome = "denied";
    pending.timer = null;
    this.#options.changed();
  }

  #settle(pending: ResetPendingRecord): void {
    if (pending.timer) clearTimeout(pending.timer);
    pending.timer = null;
    if (pending.seat.pending === pending) pending.seat.pending = null;
  }

  #endGrant(grant: ResetGrantRecord): void {
    if (grant.timer) clearTimeout(grant.timer);
    grant.timer = null;
    grant.seat.grants.delete(grant.id);
    this.#options.changed();
  }

  #leave(seat: ResetSeat): void {
    if (this.#seats.get(seat.identity.key) !== seat) return;
    if (seat.pending) this.#settle(seat.pending);
    for (const grant of [...seat.grants.values()]) this.#endGrant(grant);
    this.#seats.delete(seat.identity.key);
    this.#options.changed();
  }

  end(): void {
    if (this.#over) return;
    this.#over = true;
    for (const seat of this.#seats.values()) {
      if (seat.pending) this.#settle(seat.pending);
      for (const grant of [...seat.grants.values()]) this.#endGrant(grant);
    }
    this.#seats.clear();
    this.#options.changed();
  }
}
