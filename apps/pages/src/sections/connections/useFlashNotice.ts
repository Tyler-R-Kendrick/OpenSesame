import type { Flash } from "@opensesame/app-core/sections/connections/shared.js";
import { useEffect } from "react";
import {
  clearConnectorFailure,
  noteConnectorFailure,
} from "./connector-failure.js";

/**
 * Mirror the page's failure mark into the bell. The mark says it in a label a
 * 14px glyph carries; the bell says it as a sentence someone can read, and
 * lights up when the person is looking elsewhere. A success clears it, and so
 * does leaving the page: it is a condition of this page, not of the session.
 */
export function useFlashNotice(
  flash: Flash | null,
  scope: string,
  title: string,
): void {
  useEffect(() => {
    if (flash && flash.tone !== "ok") {
      noteConnectorFailure(scope, title, flash.text, flash.tone);
    } else {
      clearConnectorFailure(scope);
    }
  }, [flash, scope, title]);
  useEffect(() => () => clearConnectorFailure(scope), [scope]);
}
