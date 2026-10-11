/**
 * The making of one shown-once key, from the press that starts it to the sheet
 * that is closed over it (ADR 0192 §6). A key is shown once, so nothing here
 * may let it be made without being seen: the sheet cannot be dismissed while
 * one is being made, a key that finishes after the sheet is gone is revoked on
 * the spot, and the press that made the key cannot also be the one that closes
 * the sheet over it.
 */
import {
  activeModelKeyBroker,
  notifyModelKeys,
} from "@opensesame/app-core/lib/model-keys/active.js";
import type { IssuedRoot } from "@opensesame/app-core/lib/model-keys/broker.js";
import { describeMintFailure } from "@opensesame/app-core/lib/model-keys/mint-failure.js";
import type { BoundaryValue } from "@opensesame/os-domain";
import { useEffect, useRef, useState } from "react";

/** Done does not answer an activation this soon after the key appears: the press that made it may still be down. */
const DONE_GUARD_MS = 600;

/** A key no sheet holds is a live key nobody can see or copy; end it before it can be spent. */
function revokeUnseen(root: IssuedRoot): void {
  void activeModelKeyBroker()?.revoke({ id: root.id }).then(notifyModelKeys);
}

export function useMintFlight(onClose: () => void) {
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState("");
  const [issued, setIssued] = useState<IssuedRoot | null>(null);
  // Refs, not state: a second activation arrives before the next render.
  const alive = useRef(true);
  const making = useRef(false);
  const issuedAt = useRef(0);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const land = (root: IssuedRoot) => {
    if (!alive.current) return revokeUnseen(root);
    issuedAt.current = Date.now();
    setIssued(root);
  };

  /** Run `make` as the one key in flight; asked again while it runs, do nothing. */
  const start = (make: () => Promise<IssuedRoot>) => {
    if (making.current) return;
    making.current = true;
    setBusy(true);
    setFailure("");
    make()
      .then(land)
      .catch((error: BoundaryValue) => {
        if (alive.current) setFailure(describeMintFailure(error));
      })
      .finally(() => {
        making.current = false;
        if (alive.current) setBusy(false);
      });
  };

  const close = () => {
    // A key is being made; closing now would lose it before it is shown.
    if (making.current) return;
    // The key was never kept; dropping the state is forgetting it.
    setIssued(null);
    onClose();
  };

  const done = () => {
    if (Date.now() - issuedAt.current < DONE_GUARD_MS) return;
    close();
  };

  return { busy, failure, issued, start, close, done };
}
