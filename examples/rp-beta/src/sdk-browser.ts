import { createOpenSesame as createOpenSesameImpl } from "@opensesame/sdk-browser";

export type { Session } from "@opensesame/sdk-browser";

export const sdkBrowserSeams = {
  createOpenSesame: createOpenSesameImpl,
};

export function createOpenSesame(
  ...args: Parameters<typeof createOpenSesameImpl>
): ReturnType<typeof createOpenSesameImpl> {
  return sdkBrowserSeams.createOpenSesame(...args);
}
