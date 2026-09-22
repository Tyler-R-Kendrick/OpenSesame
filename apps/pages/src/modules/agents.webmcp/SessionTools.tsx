/**
 * Session tools, bound where the route is known.
 *
 * `webmcp/lifecycle.ts`'s `useWebMcp` did this with `useLocation` inside the
 * shell. The shell is core now, so the binding arrives as a shell wrapper
 * this capability contributes: it renders its children unchanged and holds
 * the session scope registered for as long as it is mounted — which is
 * exactly while the vault is unlocked, since the shell is behind that gate.
 *
 * The context (`settings`, `access`, `vault`, an editor kind…) is the same
 * function the surface always used, so which session tools an agent sees on
 * which screen is unchanged.
 */

import type { ReactElement, ReactNode } from "react";
import { useEffect } from "react";
import { useLocation } from "react-router";
import { useSyncExternalStore } from "react";
import {
  getWebMcpEditorKind,
  sessionToolsFor,
  subscribeWebMcpEditorKind,
  webmcpContext,
} from "../../webmcp/context.js";
import { contributedTools, holdScope } from "./surface.js";

export function WebMcpSessionTools({
  children,
}: { children?: ReactNode }): ReactElement {
  const { pathname } = useLocation();
  const editorKind = useSyncExternalStore(
    subscribeWebMcpEditorKind,
    getWebMcpEditorKind,
  );
  const context = webmcpContext(pathname, editorKind);

  useEffect(() => {
    const controller = new AbortController();
    holdScope(
      "session",
      () =>
        sessionToolsFor(
          contributedTools("session").map((tool) => ({
            ...tool,
            scope: "session" as const,
          })),
          context,
        ),
      controller.signal,
    );
    return () => controller.abort("unmounted");
  }, [context]);

  return <>{children}</>;
}
