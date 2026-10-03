/**
 * The owner's transport profile as React state (ADR 0150 §6): read from the
 * open vault's sealed file, and read again whenever the Form or the file
 * viewer writes it.
 *
 * Edits are functions of the profile, and each is applied to the profile
 * as it is when its turn comes: read, edit, write, one at a time. A second
 * edit made while the first is still being sealed builds on the first, not
 * on what the screen showed before it, and no slow write lands after a fast
 * one. What the screen draws meanwhile is the kept profile with the pending
 * edits applied; a refused or failed edit drops out and the last kept
 * profile is what remains.
 *
 * A saved profile that is there and cannot be used is `refused`, never
 * "direct only": the Form does not start a session on a guess at it.
 */

import {
  TransportRefused,
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
import { useCallback, useEffect, useRef, useState } from "react";

export const transportSeams = {
  tomb: (): string => vaultStore.activeTomb(),
  read: (tomb: string): Promise<LiveTransport> => readLiveTransport(tomb),
  write: (tomb: string, transport: LiveTransport): Promise<void> =>
    writeLiveTransport(tomb, transport),
};

/** A change to the profile, made against the profile as it is by then. */
export type Edit = (current: LiveTransport) => LiveTransport;

export type TransportView = Readonly<{
  transport: LiveTransport;
  loaded: boolean;
  /** Why the saved profile cannot be used; null when it can. */
  refused: string | null;
  /** Apply an edit; the refusal it meets, or null once written. */
  change: (edit: Edit) => Promise<string | null>;
}>;

const NOT_KEPT = "This vault could not keep the change";
const NOT_READ = "This vault's routes could not be read";

function check(next: LiveTransport) {
  return readTransport(JSON.parse(transportFileText(next)));
}

export function useLiveTransport(): TransportView {
  const [transport, setTransport] = useState<LiveTransport>(DIRECT_TRANSPORT);
  const [loaded, setLoaded] = useState(false);
  const [refused, setRefused] = useState<string | null>(null);
  /** The last profile known to be sealed. */
  const kept = useRef<LiveTransport>(DIRECT_TRANSPORT);
  const pending = useRef<{ edit: Edit }[]>([]);
  const tail = useRef<Promise<unknown>>(Promise.resolve());
  /** Bumped by every load and write, so a read that lost the race is dropped. */
  const epoch = useRef(0);
  const alive = useRef(true);

  const draw = useCallback(() => {
    if (!alive.current) return;
    setTransport(
      pending.current.reduce((shown, { edit }) => {
        const checked = check(edit(shown));
        return checked.ok ? checked.transport : shown;
      }, kept.current),
    );
  }, []);

  const load = useCallback(() => {
    // Edits in flight end in a load of their own.
    if (pending.current.length > 0) return;
    epoch.current += 1;
    const at = epoch.current;
    Promise.resolve()
      .then(() => transportSeams.read(transportSeams.tomb()))
      .then(
        (next) => {
          if (!alive.current || at !== epoch.current) return;
          kept.current = next;
          setTransport(next);
          setRefused(null);
          setLoaded(true);
        },
        (error) => {
          if (!alive.current || at !== epoch.current) return;
          kept.current = DIRECT_TRANSPORT;
          setTransport(DIRECT_TRANSPORT);
          setRefused(
            error instanceof TransportRefused ? error.message : NOT_READ,
          );
          setLoaded(true);
        },
      );
  }, []);

  useEffect(() => {
    alive.current = true;
    load();
    const stop = onTransportChange(load);
    return () => {
      alive.current = false;
      stop();
    };
  }, [load]);

  const commit = useCallback(
    async (entry: { edit: Edit }): Promise<string | null> => {
      epoch.current += 1;
      let outcome: string | null = null;
      try {
        const tomb = transportSeams.tomb();
        const checked = check(entry.edit(await transportSeams.read(tomb)));
        if (checked.ok) {
          await transportSeams.write(tomb, checked.transport);
          kept.current = checked.transport;
        } else outcome = checked.errors[0] ?? "Refused";
      } catch (error) {
        outcome = error instanceof TransportRefused ? error.message : NOT_KEPT;
      }
      epoch.current += 1;
      pending.current = pending.current.filter((one) => one !== entry);
      draw();
      load();
      return outcome;
    },
    [draw, load],
  );

  const change = useCallback(
    (edit: Edit): Promise<string | null> => {
      const entry = { edit };
      pending.current.push(entry);
      // Drawn at once, so a switch answers the click.
      draw();
      const run = tail.current.then(() => commit(entry));
      tail.current = run;
      return run;
    },
    [draw, commit],
  );

  return { transport, loaded, refused, change };
}
