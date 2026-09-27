/**
 * The two seams WebMCP tools call through, bound by whoever owns the live
 * function: the `agents.webmcp` surface binds the router under its lease,
 * the support panel binds its open/start functions while mounted
 * (`tutorial/session.ts`).
 *
 * They live apart from the tools and the navigation tool so the core can
 * bind them without shipping either: a build that excluded `agents.webmcp`
 * still mounts the shell and the support panel.
 */

export const webmcpNavigationSeam = {
  navigate: (_to: string): void => {
    throw new Error("router_unavailable");
  },
};

export type WebMcpSupportSeam = {
  openSupport: (topic: string | null) => void;
  startGuide: (goal: string) => void;
};

/**
 * Support seam: the support panel binds its live open/start functions here
 * while it is mounted, the way the lifecycle hook binds the router. The
 * defaults are silent no-ops so both guidance tools stay callable — and keep
 * rejecting arguments that are not authored ids — in a build that ships no
 * support UI, and in tests that drive them without one.
 */
export const webmcpSupportSeam: WebMcpSupportSeam = {
  openSupport: () => {},
  startGuide: () => {},
};
