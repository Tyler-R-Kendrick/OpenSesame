/**
 * Mirror a page condition into the notifications tray: the notice is present
 * while the condition holds and this component stays mounted, and gone when
 * either ends. Pages report Host-down, Identity-unreachable, and failed loads
 * this way instead of stacking banners above their content.
 */

import { useEffect } from "react";
import {
  type StatusNoticeInput,
  dismissNotice,
  setStatusNotice,
} from "./notices.js";

export function useStatusNotice(notice: StatusNoticeInput | null): void {
  const id = notice?.id;
  const tone = notice?.tone;
  const title = notice?.title;
  const body = notice?.body;
  const linkTo = notice?.linkTo;
  const linkLabel = notice?.linkLabel;
  const retry = notice?.retry;
  const retryLabel = notice?.retryLabel;
  useEffect(() => {
    if (
      id === undefined ||
      tone === undefined ||
      title === undefined ||
      body === undefined
    ) {
      return;
    }
    setStatusNotice({
      id,
      tone,
      title,
      body,
      linkTo,
      linkLabel,
      retry,
      retryLabel,
    });
    return () => dismissNotice(id);
  }, [id, tone, title, body, linkTo, linkLabel, retry, retryLabel]);
}
