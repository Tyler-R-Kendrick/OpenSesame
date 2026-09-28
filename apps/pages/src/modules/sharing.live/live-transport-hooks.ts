/**
 * The owner's transport profile as React state (ADR 0150 §6): read from the
 * open vault's sealed file, and read again whenever the Form or the file
 * viewer writes it.
 */

import {
  onTransportChange,
  readLiveTransport,
  writeLiveTransport,
} from "@opensesame/app-core/lib/live/transport-store.js";
import {
  DIRECT_TRANSPORT,
  type LiveTransport,
  readTransport,
  transportFileText,
} from "@opensesame/app-core/lib/live/transport.js";
import { vaultStore } from "@opensesame/app-core/lib/vault/store.js";
import { useEffect, useState } from "react";

export const transportSeams = {
  tomb: (): string => vaultStore.activeTomb(),
  read: (tomb: string): Promise<LiveTransport> => readLiveTransport(tomb),
  write: (tomb: string, transport: LiveTransport): Promise<void> =>
    writeLiveTransport(tomb, transport),
};

export type TransportView = Readonly<{
  transport: LiveTransport;
  loaded: boolean;
  /** Apply a change; the refusal a profile meets, or null once written. */
  change: (next: LiveTransport) => Promise<string | null>;
}>;

export function useLiveTransport(): TransportView {
  const [transport, setTransport] = useState<LiveTransport>(DIRECT_TRANSPORT);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    let live = true;
    const load = () => {
      transportSeams.read(transportSeams.tomb()).then(
        (next) => {
          if (!live) return;
          setTransport(next);
          setLoaded(true);
        },
        () => {
          if (live) setLoaded(true);
        },
      );
    };
    load();
    const stop = onTransportChange(load);
    return () => {
      live = false;
      stop();
    };
  }, []);

  async function change(next: LiveTransport): Promise<string | null> {
    const checked = readTransport(JSON.parse(transportFileText(next)));
    if (!checked.ok) return checked.errors[0] ?? "Refused";
    const before = transport;
    // Drawn at once, so a switch answers the click; put back if not kept.
    setTransport(checked.transport);
    try {
      await transportSeams.write(transportSeams.tomb(), checked.transport);
      return null;
    } catch {
      setTransport(before);
      return "This vault could not keep the change";
    }
  }

  return { transport, loaded, change };
}
