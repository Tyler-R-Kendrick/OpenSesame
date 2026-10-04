import { useFailureNotice } from "./use-failure-notice.js";

/**
 * Where a screen once drew a red box, it mounts this: the failure goes to the
 * notifications tray and nothing is drawn in the page. Pair it with a
 * `StatusMark` on the row, field or receipt that failed when there is one.
 */
export function FailureNotice({
  id,
  title,
  message,
  tone = "err",
  occurrence,
}: {
  id: string;
  title: string;
  message: string | null | undefined;
  tone?: "warn" | "err";
  /** A value whose identity changes with each new failure (see the hook). */
  occurrence?: unknown;
}) {
  useFailureNotice(id, title, message, tone, { occurrence });
  return null;
}
