/**
 * What a finished recovery handed back, kept for as long as this panel is on
 * the page (ADR 0187 §10).
 *
 * Opening a recovery does not end it: its key stays on the device, so a
 * reload, or a download that went nowhere, finds it again, complete, ready to
 * open. The document it opened is held here, in this hook's state and nowhere
 * else: not in storage, not in a module variable, never drawn, never copied,
 * never logged. The only ways out are a download and the Import sheet. Only
 * when one of those has happened is the document safe, and only then is the
 * recovery ended (`finishRecovery`) and its key removed; the row keeps the
 * document until the vault locks or the panel goes, in case the download was
 * cancelled.
 */

import {
  type DeskPorts,
  finishRecovery,
} from "@opensesame/app-core/lib/quorum/desk/index.js";
import { useCallback, useState } from "react";
import { useCeremonyFailure } from "../failure-text.js";

/** Where the items went: a file, or this vault. */
export type Safe = "file" | "vault";

export type Recovered = Readonly<{
  requestId: string;
  /** The circle's name, for the row and the file. */
  label: string;
  /** The recovered document as the text of a file. */
  text: string;
  /** Where it has been put, once it has; `null` until then. */
  safe: Safe | null;
}>;

export type RecoveredItems = Readonly<{
  held: readonly Recovered[];
  keep: (item: Omit<Recovered, "safe">) => void;
  /** The document is in a file or in the vault: end the recovery. */
  secure: (requestId: string, where: Safe) => Promise<void>;
  /** The sentence for why ending `requestId` did not work; empty otherwise. */
  failure: (requestId: string) => string;
}>;

export function useRecovered(
  ports: DeskPorts,
  refresh: () => Promise<void>,
): RecoveredItems {
  const [held, setHeld] = useState<readonly Recovered[]>([]);
  const [failedFor, setFailedFor] = useState<string | null>(null);
  const finishing = useCeremonyFailure(
    "trusted-contacts:recovery-finish",
    "Recovery",
  );
  const { run } = finishing;
  const keep = useCallback((item: Omit<Recovered, "safe">) => {
    setHeld((now) => [
      ...now.filter((one) => one.requestId !== item.requestId),
      { ...item, safe: null },
    ]);
  }, []);
  const secure = useCallback(
    async (requestId: string, where: Safe) => {
      setHeld((now) =>
        now.map((one) =>
          one.requestId === requestId ? { ...one, safe: where } : one,
        ),
      );
      const done = await run(() => finishRecovery(ports, requestId));
      setFailedFor(done.ok ? null : requestId);
      await refresh();
    },
    [run, ports, refresh],
  );
  const failure = useCallback(
    (requestId: string) => (failedFor === requestId ? finishing.message : ""),
    [failedFor, finishing.message],
  );
  return { held, keep, secure, failure };
}
