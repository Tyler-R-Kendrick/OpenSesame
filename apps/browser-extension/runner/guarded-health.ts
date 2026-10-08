import { createApiClient } from "@opensesame/api-client";
type HealthClient = Pick<
  ReturnType<typeof createApiClient>,
  "health" | "probeDaemon" | "discover"
>;
export type GuardedHealth = {
  hostBase: string;
  health: Awaited<ReturnType<HealthClient["health"]>>;
  daemon: Awaited<ReturnType<HealthClient["probeDaemon"]>>;
  discovery: Awaited<ReturnType<HealthClient["discover"]>>;
};
/** Never let a completed stale read authorize the next external request. */
export async function readGuardedHealth(
  check: () => Promise<void>,
  resolveHostBase: () => Promise<string>,
  createClient: (hostBase: string) => HealthClient,
): Promise<GuardedHealth> {
  await check();
  const hostBase = await resolveHostBase();
  await check();
  const client = createClient(hostBase);
  const health = await client.health();
  await check();
  const daemon = await client.probeDaemon();
  await check();
  const discovery = await client.discover();
  await check();
  return { hostBase, health, daemon, discovery };
}

/** Guard SDK fallback requests as well as its public operations. */
export function createGuardedHealthClient(
  hostBase: string,
  check: () => Promise<void>,
  fetchImpl: typeof fetch = fetch,
): HealthClient {
  return createApiClient({
    baseUrl: hostBase,
    fetchImpl: async (resource, init) => {
      await check();
      const response = await fetchImpl(resource, init);
      try {
        await check();
      } catch (error) {
        await response.body?.cancel();
        throw error;
      }
      return response;
    },
  });
}
