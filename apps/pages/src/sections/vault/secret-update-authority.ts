import {
  dismissNotice,
  listNotices,
  setStatusNotice,
} from "@opensesame/app-core/lib/notices.js";
import { pinTombAuthority } from "@opensesame/app-core/lib/vfs.js";
import { useEffect, useRef, useState } from "react";
import { useVault, useVaultStore } from "../../lib/vault/hooks.js";
import { pinSecurityOwner } from "../settings/security/security-owner.js";

type EditorOwner = { id: number; check: () => void };
function current(owner: EditorOwner | null): boolean {
  try {
    if (!owner) return false;
    owner.check();
    return true;
  } catch {
    return false;
  }
}

/** Preserve one original store, authenticated root, and realm across ordinary renders. */
export function useSecretUpdateOwner(
  requireOwner: boolean,
): EditorOwner | null {
  const vault = useVault();
  const store = useVaultStore();
  const retained = useRef<EditorOwner | null>(null);
  const nextId = useRef(0);
  const originalStore = useRef(store);
  const privateWorkflow = useRef(requireOwner);
  if (
    originalStore.current === store &&
    privateWorkflow.current === requireOwner &&
    current(retained.current)
  )
    return retained.current;
  originalStore.current = store;
  privateWorkflow.current = requireOwner;
  retained.current = null;
  try {
    const admitted = store.getSnapshot();
    if (
      admitted.status !== "unlocked" ||
      admitted.awaitingSecondStep ||
      admitted.tomb !== vault.tomb
    )
      throw new Error("The secret editor session changed.");
    const owner = requireOwner
      ? pinSecurityOwner(vault.tomb)
      : () => {
          const state = store.getSnapshot();
          if (
            state.status !== "unlocked" ||
            state.awaitingSecondStep ||
            state.tomb !== vault.tomb
          )
            throw new Error("The secret editor session changed.");
        };
    const continuation = store.pinContinuation();
    const root =
      admitted.guest || admitted.decoy
        ? () => {}
        : pinTombAuthority(vault.tomb);
    const check = () => {
      owner();
      continuation();
      root();
    };
    check();
    retained.current = { id: ++nextId.current, check };
  } catch {
    // Private password workflows require an owner; generic edits retain store admission.
  }
  return retained.current;
}

/** Only the initiating editor may publish a completion, with a fixed public failure. */
export function useSecretAttempt(
  checkOwner: () => void,
  readIntent: () => number,
) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);
  const inFlight = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const check = () => {
    if (!mounted.current) throw new Error("The editor changed.");
    checkOwner();
  };
  async function attempt(
    task: (check: () => void) => Promise<void>,
    fallback: string,
  ) {
    if (inFlight.current) return;
    try {
      check();
    } catch {
      return;
    }
    const started = readIntent();
    inFlight.current = true;
    setError(null);
    setBusy(true);
    try {
      await task(check);
      check();
    } catch {
      try {
        check();
        if (started === readIntent()) setError(fallback);
      } catch {
        // A successor session never inherits the abandoned result or notice.
      }
    } finally {
      inFlight.current = false;
      try {
        check();
        setBusy(false);
      } catch {
        // The keyed replacement owns its independent busy state.
      }
    }
  }
  return { busy, error, setError, attempt };
}

/** A safe notice may outlive navigation, but never its original admitted session. */
export function SecretUpdateFailure({
  id,
  message,
  checkOwner,
}: {
  id: string;
  message: string | null;
  checkOwner: () => void;
}) {
  const store = useVaultStore();
  const raised = useRef(false);
  useEffect(() => {
    try {
      checkOwner();
      if (message) {
        raised.current = true;
        setStatusNotice({
          id,
          title: "Password update",
          tone: "err",
          body: message,
        });
      } else if (raised.current) {
        raised.current = false;
        dismissNotice(id);
      }
    } catch {
      raised.current = false;
      dismissNotice(id);
    }
  }, [id, message, checkOwner]);
  useEffect(() => {
    const stop = store.subscribe(() => {
      try {
        checkOwner();
        if (raised.current && !listNotices().some((notice) => notice.id === id))
          stop();
      } catch {
        dismissNotice(id);
        stop();
      }
    });
    return () => {
      if (!raised.current) stop();
      // An existing notice retains this retirement watcher after navigation.
    };
  }, [store, id, checkOwner]);
  return null;
}
