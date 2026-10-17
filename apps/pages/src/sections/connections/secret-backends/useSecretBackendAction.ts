import {
  type Flash,
  errorText,
} from "@opensesame/app-core/sections/connections/shared.js";
import { useCallback, useLayoutEffect, useRef, useState } from "react";

export type SecretBackendActionOwner = Readonly<{
  signal: AbortSignal;
  current(): boolean;
  check(): void;
}>;
type PendingAction = {
  epoch: symbol;
  controller: AbortController;
  ownerSignal?: AbortSignal;
  detach(): void;
  cancel(): void;
};

function actionOwner(
  signal: AbortSignal,
  current: () => boolean,
): SecretBackendActionOwner {
  return {
    signal,
    current,
    check: () => {
      if (!current())
        throw new DOMException("This action ended.", "AbortError");
    },
  };
}

function pendingAction(
  epoch: symbol,
  ownerSignal: AbortSignal | undefined,
  retire: (token: PendingAction, clearMarks?: boolean) => void,
) {
  let cancel = () => {};
  const cancelled = new Promise<undefined>((resolve) => {
    cancel = () => resolve(undefined);
  });
  const token: PendingAction = {
    epoch,
    controller: new AbortController(),
    ownerSignal,
    cancel,
    detach: () => ownerSignal?.removeEventListener("abort", ownerEnded),
  };
  const ownerEnded = () => retire(token, true);
  return {
    token,
    cancelled,
    subscribe: () =>
      ownerSignal?.addEventListener("abort", ownerEnded, { once: true }),
  };
}

/** One mounted operation owns its mark and tray notice until completion or cancellation. */
export function useSecretBackendAction(
  onFlash: (flash: Flash) => void,
  ownerSignal?: AbortSignal,
) {
  const mounted = useRef<symbol | null>(null);
  const pending = useRef<PendingAction | null>(null);
  const committed = useRef({ onFlash, ownerSignal });
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState("");
  const [result, setResult] = useState("");
  const retire = useCallback((token: PendingAction, clearMarks = false) => {
    if (pending.current !== token) return;
    pending.current = null;
    if (mounted.current === token.epoch) {
      setBusy(false);
      if (clearMarks) {
        setFailure("");
        setResult("");
      }
    }
    token.detach();
    token.cancel();
    token.controller.abort();
  }, []);
  const clear = useCallback(() => {
    const token = pending.current;
    if (token) retire(token, true);
    else if (mounted.current) {
      setBusy(false);
      setFailure("");
      setResult("");
    }
  }, [retire]);
  useLayoutEffect(() => {
    const epoch = Symbol("secret backend action mount");
    mounted.current = epoch;
    setBusy(false);
    setFailure("");
    setResult("");
    return () => {
      if (mounted.current !== epoch) return;
      mounted.current = null;
      const token = pending.current;
      if (token) retire(token);
    };
  }, [retire]);
  useLayoutEffect(() => {
    committed.current = { onFlash, ownerSignal };
    const token = pending.current;
    if (token && token.ownerSignal !== ownerSignal) retire(token, true);
  }, [onFlash, ownerSignal, retire]);
  const run = useCallback(
    async (
      action: (owner: SecretBackendActionOwner) => Promise<string | undefined>,
    ): Promise<boolean> => {
      const epoch = mounted.current;
      const ownerSignal = committed.current.ownerSignal;
      if (!epoch || pending.current || ownerSignal?.aborted) return false;
      const { token, cancelled, subscribe } = pendingAction(
        epoch,
        ownerSignal,
        retire,
      );
      const { controller } = token;
      const current = () =>
        mounted.current === epoch &&
        pending.current === token &&
        committed.current.ownerSignal === ownerSignal &&
        !controller.signal.aborted &&
        !ownerSignal?.aborted;
      const owner = actionOwner(controller.signal, current);
      pending.current = token;
      subscribe();
      if (!current()) {
        retire(token, true);
        return false;
      }
      setBusy(true);
      setFailure("");
      setResult("");
      try {
        const message = await Promise.race([action(owner), cancelled]);
        if (!current()) return false;
        if (message) setResult(message);
        return true;
      } catch (error) {
        if (!current()) return false;
        const message = errorText(error);
        setFailure(message);
        committed.current.onFlash({ tone: "err", text: message });
        return false;
      } finally {
        retire(token);
      }
    },
    [retire],
  );
  return { busy, failure, result, clear, run };
}
