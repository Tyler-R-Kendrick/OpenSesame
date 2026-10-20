import type { ReactNode } from "react";
import { createPortal } from "react-dom";

/** Keep the switcher's glyph beside its name, or in the header's glyph pair. */
export function PromptGlyph({
  glyphHost,
  children,
}: { glyphHost?: HTMLElement | null; children: ReactNode }) {
  if (glyphHost === undefined) return children;
  if (glyphHost === null) return null;
  return createPortal(children, glyphHost);
}
