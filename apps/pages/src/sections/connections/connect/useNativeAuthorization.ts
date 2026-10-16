/** Only the original popup close capability survives a public connector revision. */
import { vaultStore } from "@opensesame/app-core/lib/vault/store.js";
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useLocation } from "react-router";
import type { NativeAuthorizationTicket } from "./native-connector-controller.js";

type PendingAuthorization = {
  ticket: NativeAuthorizationTicket;
  owner: object;
  lease: object;
  retire(close?: boolean): void;
};

function nativeVaultUiScope() {
  const state = vaultStore.getSnapshot();
  return JSON.stringify([
    state.status,
    state.tomb,
    state.guest,
    state.awaitingSecondStep,
    state.decoy,
  ]);
}

export function useNativeAuthorization(
  providerId: string,
  connectionId?: string,
) {
  const { pathname, search } = useLocation();
  const [generation, setGeneration] = useState(0);
  const owner = useMemo(
    () => ({ providerId, pathname, search, generation }),
    [providerId, pathname, search, generation],
  );
  const latest = useRef(owner);
  latest.current = owner;
  const mount = useRef<object | null>(null);
  const current = useRef<PendingAuthorization | null>(null);
  const [pending, setPending] = useState<PendingAuthorization | null>(null);
  const withdraw = useRef(() => {});
  useLayoutEffect(() => {
    const lease = { owner };
    mount.current = lease;
    let scope = nativeVaultUiScope();
    const end = () => {
      if (mount.current !== lease) return;
      mount.current = null;
      const previous = current.current;
      current.current = null;
      setPending((entry) => (entry === previous ? null : entry));
      setGeneration((value) => value + 1);
      previous?.retire(true);
    };
    withdraw.current = end;
    const stopLock = vaultStore.onLock(end);
    const stopSnapshot = vaultStore.subscribe(() => {
      const next = nativeVaultUiScope();
      if (scope !== next) {
        scope = next;
        end();
      }
    });
    return () => {
      stopLock();
      stopSnapshot();
      if (mount.current === lease) mount.current = null;
      if (current.current?.lease === lease) current.current.retire(true);
    };
  }, [owner]);
  const selected = useRef(connectionId);
  useLayoutEffect(() => {
    const previous = selected.current;
    selected.current = connectionId;
    if (previous && previous !== connectionId) withdraw.current();
  }, [connectionId]);
  const onAuthorization = useCallback(
    (ticket: NativeAuthorizationTicket) => {
      const check = () => {
        const lease = mount.current;
        if (!lease || latest.current !== owner) {
          ticket.cancel();
          throw new Error("This provider sign-in page ended");
        }
        return lease;
      };
      const lease = check();
      current.current?.retire(true);
      if (check() !== lease) {
        ticket.cancel();
        throw new Error("This provider sign-in page ended");
      }
      let closed = false;
      const entry: PendingAuthorization = {
        ticket,
        owner,
        lease,
        retire(close = false) {
          if (closed) return;
          closed = true;
          if (current.current === entry) current.current = null;
          if (mount.current === lease)
            setPending((previous) => (previous === entry ? null : previous));
          if (close) ticket.cancel();
        },
      };
      current.current = entry;
      setPending(entry);
      return () => entry.retire();
    },
    [owner],
  );
  return {
    generation,
    onAuthorization,
    authorization:
      pending?.owner === owner && pending.ticket.current()
        ? pending.ticket
        : null,
  };
}
