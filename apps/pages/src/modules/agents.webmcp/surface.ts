/**
 * Keeping the browser's model context in step with the plan.
 *
 * Two halves, because the two scopes need different things. Boot tools
 * (status, navigate, health) live for as long as the app is mounted and
 * need only the router seam, so they are a `background-job` under the
 * lease. Session tools exist only between unlock and lock and are filtered
 * by the route the person is on, so they are bound from the shell wrapper
 * in `SessionTools.tsx`, which is mounted exactly when the vault is open.
 *
 * Both register the *contributed* set — what the core kept after filtering
 * `webmcp-tool` entries by the plan's approved operations — and both
 * re-register when that set changes, so approving or disabling another
 * capability mid-session is reflected without a reload.
 */

import type { WebMcpToolSpec } from "@opensesame/webmcp";
import {
  contributionsSnapshot,
  subscribeContributions,
} from "../../lib/contributions.js";
import { webmcpNavigationSeam } from "../../webmcp/navigation.js";
import { type WebMcpScope, registerWebMcpScope } from "./registrar.js";

type Scoped = WebMcpToolSpec & { readonly scope?: string };

/** Contributed tools of one scope, in the registry's order. */
export function contributedTools(scope: WebMcpScope): WebMcpToolSpec[] {
  return contributionsSnapshot("webmcp-tool").filter(
    (tool) => (tool as Scoped).scope === scope,
  );
}

/** A stable identity for a tool set, so a re-register only happens on change. */
export function toolSetKey(tools: readonly WebMcpToolSpec[]): string {
  return tools.map((tool) => tool.name).join("\u0000");
}

/**
 * Hold `scope` registered with whatever `select` currently yields, until
 * `signal` aborts. Returns nothing: the signal is the only way out, which
 * is what keeps a disabled capability from leaving tools on the page.
 */
export function holdScope(
  scope: WebMcpScope,
  select: () => WebMcpToolSpec[],
  signal: AbortSignal,
): void {
  if (signal.aborted) return;
  let unregister: (() => void) | null = null;
  let key: string | null = null;
  let generation = 0;

  const sync = () => {
    if (signal.aborted) return;
    const tools = select();
    const next = toolSetKey(tools);
    if (next === key) return;
    key = next;
    unregister?.();
    unregister = null;
    if (tools.length === 0) return;
    const mine = ++generation;
    void registerWebMcpScope(scope, tools, signal).then(
      (off) => {
        // A later sync (or the abort) won the race: drop this registration
        // rather than leaving two of the same names on the page.
        if (signal.aborted || mine !== generation) off();
        else unregister = off;
      },
      () => {
        // No model context, or an SDK that refused to load: the page is
        // unchanged, which is what a browser without WebMCP already sees.
        key = null;
      },
    );
  };

  const stopContributions = subscribeContributions(sync);
  signal.addEventListener(
    "abort",
    () => {
      stopContributions();
      generation += 1;
      unregister?.();
      unregister = null;
    },
    { once: true },
  );
  sync();
}

/**
 * The boot job: point the navigation seam at the router this activation was
 * given, then hold the boot scope. Without the `navigate` port the seam
 * keeps its throwing default (`router_unavailable`) — which is what the
 * tools reported before, not a silent no-op.
 */
export function startBootTools(
  signal: AbortSignal,
  navigate?: (to: string) => void,
): void {
  if (signal.aborted) return;
  if (navigate) {
    const previous = webmcpNavigationSeam.navigate;
    webmcpNavigationSeam.navigate = navigate;
    signal.addEventListener(
      "abort",
      () => {
        webmcpNavigationSeam.navigate = previous;
      },
      { once: true },
    );
  }
  holdScope("boot", () => contributedTools("boot"), signal);
}
