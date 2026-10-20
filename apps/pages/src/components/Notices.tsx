import { NoticeCorner } from "./NoticeCorner.js";
import { ToastStack } from "./ToastStack.js";

/**
 * The notices of a screen with no shell: the bell's corner and the toasts.
 * The toasts are a fixed block above the statusline, and the unlocked shell
 * draws the same block (`AppShell`), so there is one stack on every screen.
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
