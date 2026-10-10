/**
 * The recoveries this vault's owner has started and not finished, read from
 * the desk's pending store (ADR 0186 §10). They load when the panel opens and
 * again whenever the desk is refreshed or a ceremony step calls `refresh`.
 */

import {
  type RecoveryView,
  listRecoveries,
} from "@opensesame/app-core/lib/quorum/desk/index.js";
import { useCallback, useEffect, useRef, useState } from "react";
import { useCeremonyFailure } from "./failure-text.js";
import type { Desk } from "./use-desk.js";

export type Recoveries = Readonly<{
  /** `null` until the first read. */
  views: readonly RecoveryView[] | null;
  /** The sentence for why they could not be read; empty when they were. */
  failure: string;
  refresh: () => Promise<void>;
}>;

export function useRecoveries(desk: Desk): Recoveries {
  const [views, setViews] = useState<readonly RecoveryView[] | null>(null);
  const failure = useCeremonyFailure("trusted-contacts:recoveries", "Recovery");
  const { run } = failure;
  const latest = useRef(0);
  const refresh = useCallback(async () => {
    latest.current += 1;
    const mine = latest.current;
    const done = await run(() => listRecoveries(desk.ports));
    // A slower, older read must not replace a newer one.
    if (done.ok && mine === latest.current) setViews(done.value);
  }, [desk, run]);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  return { views, failure: failure.message, refresh };
}
