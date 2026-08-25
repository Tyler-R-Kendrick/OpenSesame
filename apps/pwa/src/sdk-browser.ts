import {
  type OpenSesameBrowserClient,
  createOpenSesame as createOpenSesameImpl,
} from "@opensesame/sdk-browser";

export type { Session } from "@opensesame/sdk-browser";

/**
 * The PWA used to narrow this to the guest-session verbs, deliberately: there
 * was one federated provider and no reason for a second on-ramp here. The
 * provider catalog (ADR 0056, D14) is the reason — `signIn` sends the human to
 * the hosted login page, which runs whichever upstream this deployment
 * brokers. The narrowing is reversed as deliberately as it was made; the rest
 * of the client surface stays out.
 */
type PwaBrowserClient = Pick<
  OpenSesameBrowserClient,
  "getSession" | "signIn" | "continueAnonymously" | "signOut"
>;

interface PwaBrowserSeams {
  createOpenSesame: (
    ...args: Parameters<typeof createOpenSesameImpl>
  ) => PwaBrowserClient;
}

export const sdkBrowserSeams: PwaBrowserSeams = {
  createOpenSesame: createOpenSesameImpl,
};

export function createOpenSesame(
  ...args: Parameters<typeof createOpenSesameImpl>
): PwaBrowserClient {
  return sdkBrowserSeams.createOpenSesame(...args);
}
