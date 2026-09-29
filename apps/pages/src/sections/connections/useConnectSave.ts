import {
  type Connection,
  type Provider,
  createConnection,
} from "@opensesame/app-core/lib/connections.js";
import {
  type Flash,
  errorText,
} from "@opensesame/app-core/sections/connections/shared.js";
import { useRef, useState } from "react";
import {
  clearConnectorFailure,
  noteConnectorFailure,
} from "./connector-failure.js";

/**
 * A form that makes a connection and then seals something in it (a key, a
 * configuration). Saving is all or nothing to the person: what they typed
 * stays until the whole save has worked, and a failure is said beside the key
 * that was pressed and in the bell, never lost.
 *
 * A connection made by a try that then failed is kept for the next try, so a
 * retry seals into it instead of making a second one. The page is not asked
 * to reload until the save is done: a reload would swap this form for the
 * half-made connection's card, and take the typed values with it.
 */
export function useConnectSave(
  provider: Provider,
  done: {
    onFlash: (flash: Flash) => void;
    onConnected: () => void;
    onRememberOffer?: ((connection: Connection) => void) | undefined;
  },
) {
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState("");
  const made = useRef<Connection | null>(null);

  /** Returns whether the save worked, so the caller clears its fields then. */
  async function save(
    input: { name: string; scopes?: string[] | undefined },
    seal: (connection: Connection) => Promise<void>,
    success: string,
  ): Promise<boolean> {
    setBusy(true);
    setFailure("");
    clearConnectorFailure(provider.id);
    try {
      made.current ??= await createConnection({
        providerId: provider.id,
        displayName: input.name.trim() || provider.displayName,
        scopes: input.scopes,
      });
      const connection = made.current;
      await seal(connection);
      made.current = null;
      done.onFlash({ tone: "ok", text: success });
      done.onRememberOffer?.(connection);
      done.onConnected();
      return true;
    } catch (error) {
      const text = errorText(error);
      setFailure(text);
      noteConnectorFailure(provider.id, provider.displayName, text);
      return false;
    } finally {
      setBusy(false);
    }
  }

  return { busy, failure, save };
}
