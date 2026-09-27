/**
 * What a capability needs from the realm that the realm cannot host (carried
 * from #470, whose unsupported-runtime detail named the environments). The
 * resolver's `runtimeSupported` is this list being empty; the list itself
 * rides on the capability's state so an explanation can say which.
 */
import { compareIds } from "./ids.js";
import type {
  CapabilityDescriptor,
  ExecutionEnvironment,
  RuntimeFacts,
} from "./types.js";

/**
 * The environments `d` declares that these facts do not host, sorted. A
 * service worker counts as missing when one is declared but not usable here.
 */
export function missingEnvironments(
  facts: RuntimeFacts,
  d: CapabilityDescriptor,
): ExecutionEnvironment[] {
  const hosts = new Set(facts.environments);
  if (!facts.serviceWorkerAvailable) hosts.delete("service-worker");
  return [...new Set(d.environments)]
    .filter((e) => !hosts.has(e))
    .sort(compareIds);
}
