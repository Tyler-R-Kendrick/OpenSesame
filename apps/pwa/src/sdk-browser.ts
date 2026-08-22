import {
  type OpenSesameBrowserClient,
  createOpenSesame as createOpenSesameImpl,
} from "@opensesame/sdk-browser";

export type { Session } from "@opensesame/sdk-browser";

type PwaBrowserClient = Pick<
  OpenSesameBrowserClient,
  "getSession" | "continueAnonymously" | "signOut"
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
