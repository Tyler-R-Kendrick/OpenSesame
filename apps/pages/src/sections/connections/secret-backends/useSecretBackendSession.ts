import type { SecretBackendHandle } from "@opensesame/app-core/lib/secret-backends/runtime-admission.js";
import { vaultStore } from "@opensesame/app-core/lib/vault/store.js";
import {
  type Dispatch,
  type SetStateAction,
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

export type SecretBackendSessionAttempt = Readonly<{
  signal: AbortSignal;
  current(): boolean;
}>;
type SessionOwner = {
  epoch: symbol | null;
  attempt: SecretBackendSessionAttempt;
  controller: AbortController;
  closed: boolean;
  accepted: boolean;
  handle?: SecretBackendHandle;
  signals: AbortSignal[];
  detachPending(): void;
  detachHandle(): void;
};
type AcceptedSession = {
  owner: SessionOwner;
  handle: SecretBackendHandle;
  key: number;
};
type SessionState = {
  epoch: symbol | null;
  current: SessionOwner | null;
  owners: WeakMap<SecretBackendSessionAttempt, SessionOwner>;
  disposing: WeakSet<SecretBackendHandle>;
  sequence: number;
  onEnded(): void;
  publish: Dispatch<SetStateAction<AcceptedSession | null>>;
};
function dispose(state: SessionState, handle: SecretBackendHandle) {
  if (state.disposing.has(handle)) return;
  state.disposing.add(handle);
  void Promise.resolve()
    .then(() => handle.backend.disconnect(handle.session))
    .catch(() => {});
}
function close(state: SessionState, owner: SessionOwner, notify = false) {
  if (owner.closed) return;
  owner.closed = true;
  const current = state.current === owner;
  if (current) state.current = null;
  owner.detachPending();
  owner.detachHandle();
  if (owner.accepted && state.epoch === owner.epoch && state.epoch) {
    state.publish((previous) => (previous?.owner === owner ? null : previous));
  }
  if (owner.handle) dispose(state, owner.handle);
  try {
    if (
      notify &&
      current &&
      owner.accepted &&
      state.epoch === owner.epoch &&
      state.epoch
    )
      state.onEnded();
  } finally {
    owner.controller.abort();
  }
}
function makeOwner(
  state: SessionState,
  pendingSignal?: AbortSignal,
): SessionOwner {
  const controller = new AbortController();
  const owner: SessionOwner = {
    epoch: state.epoch,
    controller,
    closed: false,
    accepted: false,
    signals: [],
    detachPending: () => pendingSignal?.removeEventListener("abort", cancel),
    detachHandle: () => {},
    attempt: {
      signal: controller.signal,
      current: () =>
        !!owner.epoch &&
        state.epoch === owner.epoch &&
        state.current === owner &&
        !owner.closed &&
        !controller.signal.aborted &&
        (owner.accepted || !pendingSignal?.aborted) &&
        owner.signals.every((signal) => !signal.aborted),
    },
  };
  const cancel = () => close(state, owner);
  state.owners.set(owner.attempt, owner);
  if (!state.epoch || pendingSignal?.aborted) {
    close(state, owner);
    return owner;
  }
  const previous = state.current;
  state.current = owner;
  if (state.epoch)
    state.publish((active) => (active?.owner === previous ? null : active));
  if (previous) close(state, previous);
  if (owner.attempt.current())
    pendingSignal?.addEventListener("abort", cancel, { once: true });
  if (!owner.attempt.current()) close(state, owner);
  return owner;
}
function accept(
  state: SessionState,
  attempt: SecretBackendSessionAttempt,
  handle: SecretBackendHandle,
): boolean {
  const owner = state.owners.get(attempt);
  if (owner?.accepted && owner.handle === handle) return false;
  if (!owner || !attempt.current() || owner.handle) {
    dispose(state, handle);
    return false;
  }
  owner.handle = handle;
  owner.detachPending();
  const lifetime = handle.signal;
  const provider = handle.session.signal;
  owner.signals = [lifetime, provider].filter(
    (signal): signal is AbortSignal => signal !== undefined,
  );
  const ended = () => close(state, owner, true);
  owner.detachHandle = () => {
    for (const signal of owner.signals)
      signal.removeEventListener("abort", ended);
  };
  for (const signal of owner.signals) {
    if (owner.closed) break;
    signal.addEventListener("abort", ended, { once: true });
  }
  if (!attempt.current()) {
    close(state, owner);
    return false;
  }
  owner.accepted = true;
  state.publish({ owner, handle, key: ++state.sequence });
  return true;
}

/** The retained caller belongs to the mounted session, not its short Connect action. */
export function useSecretBackendSession(onEnded: () => void) {
  const [accepted, publish] = useState<AcceptedSession | null>(null);
  const state = useRef<SessionState>({
    epoch: null,
    current: null,
    owners: new WeakMap(),
    disposing: new WeakSet(),
    sequence: 0,
    onEnded,
    publish,
  });
  useLayoutEffect(() => {
    state.current.onEnded = onEnded;
  }, [onEnded]);
  useLayoutEffect(() => {
    const current = state.current;
    const epoch = Symbol("secret backend session mount");
    current.epoch = epoch;
    current.publish(null);
    const unsubscribe = vaultStore.onLock(() => {
      const owner = current.current;
      if (owner) close(current, owner, true);
    });
    return () => {
      if (current.epoch !== epoch) return;
      current.epoch = null;
      unsubscribe();
      const owner = current.current;
      if (owner) close(current, owner);
    };
  }, []);
  const begin = useCallback(
    (pendingSignal?: AbortSignal) =>
      makeOwner(state.current, pendingSignal).attempt,
    [],
  );
  const acceptAttempt = useCallback(
    (attempt: SecretBackendSessionAttempt, handle: SecretBackendHandle) =>
      accept(state.current, attempt, handle),
    [],
  );
  const end = useCallback((attempt: SecretBackendSessionAttempt) => {
    const owner = state.current.owners.get(attempt);
    if (owner && !owner.accepted) close(state.current, owner);
  }, []);
  const disconnect = useCallback(() => {
    const owner = state.current.current;
    if (owner) close(state.current, owner);
  }, []);
  return {
    active: accepted?.handle ?? null,
    activeKey: accepted?.key ?? 0,
    begin,
    accept: acceptAttempt,
    end,
    disconnect,
  };
}
