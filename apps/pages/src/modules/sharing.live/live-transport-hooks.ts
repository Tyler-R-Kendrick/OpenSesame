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

import { captureHostAuthority } from "@opensesame/app-core/lib/live/host-authority.js";
import {
  beginTransportEdit,
  onTransportReadinessChange,
} from "@opensesame/app-core/lib/live/transport-readiness.js";
import {
  onTransportChange,
  readLiveTransport,
  writeLiveTransport,
} from "@opensesame/app-core/lib/live/transport-store.js";
import {
  DIRECT_TRANSPORT,
  type LiveTransport,
} from "@opensesame/app-core/lib/live/transport.js";
import { vaultStore } from "@opensesame/app-core/lib/vault/store.js";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  type ProfileReadState,
  type TransportEdit,
  captureProfileConfiguration,
  commitTransportEdit,
  loadTransportProfile,
  pendingTransport,
} from "./live-transport-profile.js";

export const transportSeams = {
  tomb: (): string => vaultStore.activeTomb(),
  read: (tomb: string): Promise<LiveTransport> => readLiveTransport(tomb),
  write: (
    tomb: string,
    transport: LiveTransport,
    assertCurrent: () => void,
  ): Promise<void> => writeLiveTransport(tomb, transport, assertCurrent),
};

/** A change to the profile, made against the profile as it is by then. */
export type Edit = (current: LiveTransport) => LiveTransport;
export type TransportView = Readonly<{
  transport: LiveTransport;
  loaded: boolean;
  /** The actual sealed profile is current and no edit or reload is pending. */
  settled: boolean;
  refused: string | null;
  change: (edit: Edit) => Promise<string | null>;
  /** Pins the actual loaded profile; never grants vault authority. */
  captureConfiguration: () => () => void;
}>;

export function useLiveTransport(): TransportView {
  const [transport, setTransport] = useState<LiveTransport>(DIRECT_TRANSPORT);
  const [loaded, setLoaded] = useState(false);
  const [settled, setSettled] = useState(false);
  const [refused, setRefused] = useState<string | null>(null);
  const kept = useRef<LiveTransport>(DIRECT_TRANSPORT);
  const pending = useRef<TransportEdit[]>([]);
  const tail = useRef<Promise<unknown>>(Promise.resolve());
  const state = useRef<ProfileReadState>({
    epoch: 0,
    alive: true,
    admitted: null,
  });

  const draw = useCallback(() => {
    if (!state.current.alive) return;
    setTransport(pendingTransport(kept.current, pending.current));
  }, []);

  const load = useCallback(() => {
    loadTransportProfile({
      state: state.current,
      pending: pending.current.length,
      ports: transportSeams,
      waiting: () => setSettled(false),
      accept: (next) => {
        kept.current = next;
        setTransport(next);
        setRefused(null);
        setLoaded(true);
        setSettled(true);
      },
      refuse: (message) => {
        kept.current = DIRECT_TRANSPORT;
        setTransport(DIRECT_TRANSPORT);
        setRefused(message);
        setLoaded(true);
      },
    });
  }, []);

  useEffect(() => {
    state.current.alive = true;
    load();
    const stop = onTransportChange(load);
    const stopReadiness = onTransportReadinessChange(load);
    return () => {
      state.current.alive = false;
      state.current.admitted = null;
      stop();
      stopReadiness();
    };
  }, [load]);

  const commit = useCallback(
    (entry: TransportEdit) =>
      commitTransportEdit({
        entry,
        ports: transportSeams,
        accept: (next) => {
          kept.current = next;
        },
        done: () => {
          pending.current = pending.current.filter((one) => one !== entry);
          draw();
        },
      }),
    [draw],
  );

  const change = useCallback(
    (edit: Edit): Promise<string | null> => {
      let owner: () => void;
      try {
        owner = captureHostAuthority(vaultStore.pinContinuation());
      } catch {
        return Promise.resolve("This vault could not keep the change");
      }
      const tomb = transportSeams.tomb();
      const finish = beginTransportEdit();
      const entry = { edit, tomb, check: owner, finish };
      pending.current.push(entry);
      // The switch keeps focus and answers immediately; Start waits separately.
      draw();
      const run = tail.current.then(() => commit(entry));
      tail.current = run;
      return run;
    },
    [draw, commit],
  );

  const captureConfiguration = useCallback(
    () => captureProfileConfiguration(state.current),
    [],
  );
  return { transport, loaded, settled, refused, change, captureConfiguration };
}
