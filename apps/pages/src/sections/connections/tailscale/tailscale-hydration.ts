import { tailscaleAppDependencies as deps } from "./tailscale-dependencies.js";

const inFlight = new Map<string, Promise<void>>();

/** One device-row hydration per vault owner; concurrent panels share it. */
export function hydrateTailscaleDeviceRows(tomb: string): Promise<void> {
  const existing = inFlight.get(tomb);
  if (existing) return existing;
  const run = (async () => {
    try {
      await deps.hydrateTailscaleApps();
    } finally {
      inFlight.delete(tomb);
    }
  })();
  inFlight.set(tomb, run);
  return run;
}
