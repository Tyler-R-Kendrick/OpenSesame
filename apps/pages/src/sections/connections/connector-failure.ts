import {
  dismissNotice,
  setStatusNotice,
} from "@opensesame/app-core/lib/notices.js";

/**
 * A connector action that failed, put where a sentence can be read: the bell.
 * A `StatusMark` carries the sentence in its label, which nobody reads from a
 * 14px glyph, so the failure is mirrored into the tray as well (the way a
 * failed key protection or a failed import is). One notice per connector, so
 * a second try replaces the first instead of stacking, and a success clears it.
 */
const noticeId = (providerId: string) => `connector:${providerId}`;

export function noteConnectorFailure(
  providerId: string,
  displayName: string,
  text: string,
  tone: "warn" | "err" = "err",
): void {
  setStatusNotice({
    id: noticeId(providerId),
    tone,
    title: displayName,
    body: text,
  });
}

export function clearConnectorFailure(providerId: string): void {
  dismissNotice(noticeId(providerId));
}
