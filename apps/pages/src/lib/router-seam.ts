/**
 * The router's `navigate`, reachable from outside React.
 *
 * The capability loader builds a module's context before any component has
 * rendered, so it cannot call `useNavigate`. `agents.webmcp` needs it — its
 * `opensesame_navigate` tool moves the person between authored destinations
 * — and `ports-b.ts` named `navigate` as a port "the loader is asked to
 * add". Nothing added it, so the tool answered `router_unavailable` on
 * every call.
 *
 * The shell installs the live one while it is mounted and restores the
 * default when it unmounts, so a tool call outside the app says so rather
 * than navigating a document that is not there. Only authored destinations
 * ever reach it: the tool resolves the path against the navigation registry
 * before calling this at all.
 */

export const routerSeam = {
  navigate: (to: string): void => {
    throw new Error(`router_unavailable:${to}`);
  },
};

/** Install the router's navigate; returns the restore for the effect's cleanup. */
export function installRouterNavigate(
  navigate: (to: string) => void,
): () => void {
  const previous = routerSeam.navigate;
  routerSeam.navigate = navigate;
  return () => {
    routerSeam.navigate = previous;
  };
}
