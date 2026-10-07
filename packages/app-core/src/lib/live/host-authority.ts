import type { HostOptions, HostState } from "./host-types.js";
import { captureLiveRealmAuthority } from "./realm-authority.js";
import type { Carrier, CarrierFactory } from "./rendezvous.js";

export function captureHostAuthority(owner?: () => void): () => void {
  const realm = captureLiveRealmAuthority();
  const check = () => {
    realm();
    owner?.();
  };
  check();
  return check;
}

export function retiredHostState(): HostState {
  return {
    status: "ended",
    endedBecause: "owner",
    guests: [],
    log: [],
    misses: 0,
    locked: true,
  };
}

export function guardedHostSeat(
  options: HostOptions,
  source: Carrier | null,
  current: () => boolean,
) {
  return {
    ports: guardedHostPorts(options, current),
    relay: source
      ? guardedLiveCarrier(source, () => {
          if (!current()) throw new Error("The original live seat retired.");
        })
      : null,
  };
}

/** Revoked callbacks return no data; closing the Host closes its channel. */
export function guardedHostPorts(options: HostOptions, current: () => boolean) {
  const { catalog, readField, writeField, post } = options;
  return {
    catalog: () =>
      current()
        ? catalog()
        : { title: "Ended", policy: "use" as const, expiresAt: 0, items: [] },
    readField: async (item: string, field: string) => {
      if (!current()) return null;
      const value = await readField(item, field);
      return current() ? value : null;
    },
    writeField: writeField
      ? async (item: string, field: string, value: string) => {
          if (!current()) return false;
          const saved = await writeField(item, field, value, () => {
            if (!current()) throw new Error("The original live seat retired.");
          });
          return current() && saved;
        }
      : undefined,
    post: (code: string) => {
      if (current()) post?.(code);
    },
  };
}

/** The check runs at actual dispatch, after any SeatChannel AES queue. */
export function guardedLiveCarrier(
  carrier: Carrier,
  check: () => void,
): Carrier {
  const channel = carrier.channel?.bind(carrier);
  return {
    async post(text) {
      check();
      await carrier.post(text);
      check();
    },
    listen(listener) {
      check();
      return carrier.listen((text) => {
        try {
          check();
        } catch {
          carrier.close();
          return;
        }
        listener(text);
      });
    },
    close: () => carrier.close(),
    channel: channel
      ? (name) => {
          check();
          const child = channel(name);
          try {
            check();
            return guardedLiveCarrier(child, check);
          } catch (error) {
            child.close();
            throw error;
          }
        }
      : undefined,
  };
}

export function guardedLiveCarrierFactory(
  factory: CarrierFactory | undefined,
  check: () => void,
): CarrierFactory | undefined {
  if (!factory) return undefined;
  return async (...args) => {
    check();
    const carrier = await factory(...args);
    try {
      check();
      return guardedLiveCarrier(carrier, check);
    } catch (error) {
      carrier.close();
      throw error;
    }
  };
}
