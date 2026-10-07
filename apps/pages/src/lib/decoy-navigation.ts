import {
  isDecoySession,
  observeDecoyInteraction,
} from "@opensesame/app-core/lib/decoy-session.js";
import { useEffect } from "react";

export type SessionNavigationContext = "same_document" | "new_context";
type NavigationGesture = Pick<
  MouseEvent,
  "ctrlKey" | "metaKey" | "shiftKey" | "button"
>;
export function navigationContext(
  target: string | null | undefined,
  gesture?: NavigationGesture,
): SessionNavigationContext {
  return (target && target !== "_self") ||
    gesture?.ctrlKey ||
    gesture?.metaKey ||
    gesture?.shiftKey ||
    gesture?.button === 1
    ? "new_context"
    : "same_document";
}
/** Synthetic sessions may navigate this application document, never a fresh context. */
export function sessionNavigationAllowed(
  href: string,
  context: SessionNavigationContext = "same_document",
): boolean {
  if (!isDecoySession()) return true;
  if (context === "new_context") return false;
  try {
    return new URL(href, location.href).origin === location.origin;
  } catch {
    return false;
  }
}
export function runSessionNavigation(
  href: string,
  run: () => void,
  context: SessionNavigationContext = "same_document",
): boolean {
  if (!sessionNavigationAllowed(href, context)) {
    observeDecoyInteraction("authority_denied");
    return false;
  }
  run();
  return true;
}
/** Browser history may contain another origin; its destination is not inspectable. */
export function runSessionHistoryNavigation(run: () => void): boolean {
  if (isDecoySession()) {
    observeDecoyInteraction("authority_denied");
    return false;
  }
  run();
  return true;
}
/** Recheck ordinary and middle clicks from a link rendered before the realm changed. */
export function useSessionNavigationBoundary(): void {
  useEffect(() => {
    const capture = (event: MouseEvent) => {
      const link =
        event.target instanceof Element
          ? event.target.closest<HTMLAnchorElement>("a[href]")
          : null;
      if (
        !link ||
        sessionNavigationAllowed(
          link.href,
          navigationContext(link.target, event),
        )
      )
        return;
      observeDecoyInteraction("authority_denied");
      event.preventDefault();
      event.stopPropagation();
    };
    document.addEventListener("click", capture, true);
    document.addEventListener("auxclick", capture, true);
    return () => {
      document.removeEventListener("click", capture, true);
      document.removeEventListener("auxclick", capture, true);
    };
  }, []);
}
/** Consent callers already catch failures and display their existing error state. */
export function navigateConsentWindow(
  href: string,
  popup: Window | null,
): void {
  if (
    !runSessionNavigation(
      href,
      () => {
        if (popup) popup.location.href = href;
        else window.location.href = href;
      },
      "new_context",
    )
  ) {
    popup?.close();
    throw new Error("External navigation is unavailable in this session.");
  }
}
