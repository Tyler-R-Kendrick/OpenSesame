import { NoticeCorner } from "./NoticeCorner.js";
import { ToastStack } from "./ToastStack.js";

/**
 * The notices of a screen with no shell: the bell's corner and the toasts,
 * drawn as blocks above the body. The unlocked shell draws its own toasts as
 * a row of its frame (`AppShell`), so there is one stack on every screen.
 */
export function Notices({ shellless }: { shellless: boolean }) {
  if (!shellless) return null;
  return (
    <>
      <NoticeCorner />
      <ToastStack />
    </>
  );
}
