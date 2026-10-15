/** The real app origin can go physically unavailable during a cold offline navigation. */
import { startIdentityAppServer } from "./identity-browser-server.mjs";

export async function startSecretBackendAppServer(dist, origin, base) {
  let live = await startIdentityAppServer(dist, origin, base);
  async function pause() {
    if (!live) return;
    await live.close();
    live = null;
  }
  return {
    pause,
    async resume() {
      if (!live) live = await startIdentityAppServer(dist, origin, base);
    },
    close: pause,
  };
}
