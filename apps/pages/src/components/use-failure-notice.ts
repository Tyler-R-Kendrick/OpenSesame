import {
  dismissNotice,
  setStatusNotice,
} from "@opensesame/app-core/lib/notices.js";
import { useEffect, useRef } from "react";

/**
 * A failure belongs in the notifications tray, never in a red box inside the
 * screen (DESIGN.md § Status is a symbol, `docs/design/controls.md` § 0).
 *
 * Give this the sentence a screen would have painted and it keeps one notice
 * in the tray under `id`: a new sentence replaces the old one, an emptied
 * sentence clears it. A notice outlives the screen that raised it — leaving the
 * page does not make the failure go away — so nothing is dismissed on unmount.
 * Only a failure that clears while its screen is still here (the retry
 * worked) takes its notice with it.
 */
export function useFailureNotice(
  id: string,
  title: string,
  message: string | null | undefined,
  tone: "warn" | "err" = "err",
): void {
  const raised = useRef(false);
  useEffect(() => {
    if (message) {
      raised.current = true;
      setStatusNotice({ id, tone, title, body: message });
    } else if (raised.current) {
      raised.current = false;
      dismissNotice(id);
    }
  }, [id, title, message, tone]);
}
