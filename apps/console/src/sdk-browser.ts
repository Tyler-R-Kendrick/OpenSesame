import {
  type OpenSesameBrowserClient,
  createOpenSesame as createOpenSesameImpl,
} from "@opensesame/sdk-browser";

export type { ClaimPresentation } from "@opensesame/sdk-browser";
export { ClaimRequestError } from "@opensesame/sdk-browser";

type ConsoleBrowserClient = Pick<
  OpenSesameBrowserClient,
  | "signIn"
  | "handleRedirectCallback"
  | "getReturnTo"
  | "continueAnonymously"
  | "getSession"
  | "presentClaim"
  | "readClaim"
  | "completeClaim"
  | "signOut"
>;

interface ConsoleBrowserSeams {
  createOpenSesame: (
    ...args: Parameters<typeof createOpenSesameImpl>
  ) => ConsoleBrowserClient;
}

export const sdkBrowserSeams: ConsoleBrowserSeams = {
  createOpenSesame: createOpenSesameImpl,
};

export function createOpenSesame(
  ...args: Parameters<typeof createOpenSesameImpl>
): ConsoleBrowserClient {
  return sdkBrowserSeams.createOpenSesame(...args);
}
