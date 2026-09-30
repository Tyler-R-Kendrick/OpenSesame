/**
 * The MSAL instances this tab has made (`entra.ts`), by client id, so that
 * resetting this browser can ask each to clear its own cache — including the
 * account records MSAL does not key by client id — and knows which client
 * ids' keys in sessionStorage are the app's (`storage-ownership-msal.ts`).
 */

const instances = new Map<string, () => Promise<void>>();
const deployed = new Set<string>();

/** Client ids from the deployment policy, noted by ambient SSO when it is on. */
export function noteDeployedEntraClients(clientIds: readonly string[]): void {
  deployed.clear();
  for (const id of clientIds) {
    if (id) deployed.add(id);
  }
}

export function forgetDeployedEntraClients(): void {
  deployed.clear();
}

/** Remember an instance's cache-clearing entry point. */
export function rememberEntraInstance(
  clientId: string,
  clearCache: () => Promise<void>,
): void {
  instances.set(clientId, clearCache);
}

/** Clear every instance this tab made. Each is attempted; none throws. */
export async function clearEntraInstances(): Promise<void> {
  await Promise.allSettled([...instances.values()].map((clear) => clear()));
}

/**
 * The client ids whose MSAL keys are the app's: every instance this tab
 * made, and every provider the deployment configured (an instance a
 * previous document made leaves keys behind too).
 */
export function appEntraClientIds(): string[] {
  return [...new Set([...instances.keys(), ...deployed])];
}

/** Tests only. */
export function forgetEntraInstancesForTest(): void {
  instances.clear();
  deployed.clear();
}
