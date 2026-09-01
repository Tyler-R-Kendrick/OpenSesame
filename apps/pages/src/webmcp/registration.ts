/**
 * What this page has registered with the browser's model context, as a fact
 * the rest of the app can read.
 *
 * The registrar in `@opensesame/webmcp` is silent by design: absent an API it
 * no-ops, and a browser that refuses a registration only tells the caller
 * that asked. That silence is fine for the tools and useless for anyone trying
 * to tell whether WebMCP is working at all — the DevTools panel says "no tools
 * detected" and the page says nothing. So the lifecycle writes here every
 * time it registers or unregisters, and both the support panel and the
 * support model read it back: the panel to show a person what this browser
 * exposes, the model so that "what can this app do" is answered from what is
 * actually implemented rather than from memory.
 *
 * Nothing in this store is callable. It holds names and the descriptions the
 * page authored, never an `execute`.
 */

import type {
  ModelContextSource,
  WebMcpRegistrationFailure,
} from "@opensesame/webmcp";

export type WebMcpImplementedTool = {
  readonly name: string;
  readonly description: string;
  readonly scope: "boot" | "session";
};

export type WebMcpRegistrationSnapshot = {
  /** Which draft location answered, or null when this browser has neither. */
  readonly source: ModelContextSource | null;
  /** Every tool the page holds registered right now, by scope. */
  readonly implemented: readonly WebMcpImplementedTool[];
  /** Registrations the browser refused, with the one-line reason it gave. */
  readonly failures: readonly WebMcpRegistrationFailure[];
};

const EMPTY: WebMcpRegistrationSnapshot = {
  source: null,
  implemented: [],
  failures: [],
};

let snapshot: WebMcpRegistrationSnapshot = EMPTY;
const listeners = new Set<() => void>();

function publish(next: WebMcpRegistrationSnapshot): void {
  snapshot = next;
  for (const listener of [...listeners]) listener();
}

export function webmcpRegistrationSnapshot(): WebMcpRegistrationSnapshot {
  return snapshot;
}

export function subscribeWebMcpRegistration(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The lifecycle registered a scope: replace that scope's tools wholesale. */
export function noteWebMcpRegistered(
  source: ModelContextSource | null,
  scope: "boot" | "session",
  tools: readonly WebMcpImplementedTool[],
): void {
  publish({
    source,
    implemented: [
      ...snapshot.implemented.filter((tool) => tool.scope !== scope),
      ...tools,
    ],
    failures: snapshot.failures.filter(
      (failure) => !tools.some((tool) => tool.name === failure.name),
    ),
  });
}

export function noteWebMcpUnregistered(scope: "boot" | "session"): void {
  publish({
    source: snapshot.source,
    implemented: snapshot.implemented.filter((tool) => tool.scope !== scope),
    failures: snapshot.failures,
  });
}

/**
 * The browser refused one registration. The tool stays on the implemented
 * list — the page still has it — and stops counting as exposed.
 */
export function noteWebMcpFailure(failure: WebMcpRegistrationFailure): void {
  publish({
    source: snapshot.source,
    implemented: snapshot.implemented,
    failures: [
      ...snapshot.failures.filter((held) => held.name !== failure.name),
      failure,
    ],
  });
}

/** True when the browser accepted the tool, so an agent there can see it. */
export function isWebMcpToolExposed(name: string): boolean {
  return (
    snapshot.source !== null &&
    snapshot.implemented.some((tool) => tool.name === name) &&
    !snapshot.failures.some((failure) => failure.name === name)
  );
}

export function resetWebMcpRegistrationForTests(): void {
  publish(EMPTY);
}
