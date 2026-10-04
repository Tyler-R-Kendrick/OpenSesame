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
}: {
  id: string;
  title: string;
  message: string | null | undefined;
  tone?: "warn" | "err";
}) {
  useFailureNotice(id, title, message, tone);
  return null;
}
