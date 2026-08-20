import { createOpenSesame as createOpenSesameImpl } from "@opensesame/sdk-browser";

export type { ClaimPresentation } from "@opensesame/sdk-browser";
export { ClaimRequestError } from "@opensesame/sdk-browser";

export const sdkBrowserSeams = {
  createOpenSesame: createOpenSesameImpl,
};

export function createOpenSesame(
  ...args: Parameters<typeof createOpenSesameImpl>
): ReturnType<typeof createOpenSesameImpl> {
  return sdkBrowserSeams.createOpenSesame(...args);
}
