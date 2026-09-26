/**
 * The host this process runs in (ADR 0133 §2–3).
 *
 * The shared core runs in a browser tab, a CLI process and an Android
 * isolate. What differs between them — storage, navigation, WebAuthn, build
 * configuration — reaches the core through one `Host`, installed once, before
 * any other module does work. Standard web APIs that all three provide
 * (`crypto`, `fetch`, `URL`, timers …) are not ports; they are the runtime
 * contract.
 *
 * A port is read when it is used, never while a module loads, so importing any
 * part of the core with no host installed must not throw.
 */

import type { DistributionContract } from "@opensesame/capability-composition";
import type { ModuleTable } from "./lib/capabilities/loader.js";
import type { SecurityProfile } from "./lib/deployment-profile.js";
import type { Ports } from "./ports.js";

/**
 * Build-time configuration. In the browser the shell copies it from Vite's
 * elsewhere the embedding shell supplies the same shape.
 */
export type RuntimeEnv = {
  /** Public base path the app is served under, ending in `/`. */
  readonly BASE_URL: string;
  /** True in development and test builds. */
  readonly DEV: boolean;
  readonly VITE_CONNECT_CALLBACK_BASE?: string;
  readonly VITE_DAEMON_API?: string;
  readonly VITE_HOST_API?: string;
  readonly VITE_IDENTITY_API?: string;
  readonly VITE_SUPPORT_AGENT_URL?: string;
};

/**
 * What the shell's build compiled in for capability composition (ADR 0130):
 * the table of optional module loaders and the distribution contract. Only a
 * shell build has them, so a host without a build (a CLI, a test) omits them
 * and anything that needs them fails closed.
 */
export type CapabilityArtifacts = {
  readonly moduleTable: () => Promise<ModuleTable>;
  readonly distribution: () => Promise<DistributionContract>;
};

/**
 * The hosted static-auth SDK release the shell serves (its version directory
 * and subresource-integrity hash), from the shell's `static-auth/manifest.json`.
 */
export type StaticAuthRelease = {
  readonly version: string;
  readonly sri: string;
};

/**
 * Everything a shell hands the core: build configuration and artifacts, plus
 * the platform ports (`ports.ts`) — storage, the page, WebAuthn, workers and
 * the rest — each optional, read when used.
 */
export type Host = Ports & {
  readonly env: RuntimeEnv;
  readonly capabilities?: CapabilityArtifacts;
  /**
   * The security profile the shell's build stamped. Absent means the safe
   * default: a shared-origin demo that may not pair a local authority.
   */
  readonly securityProfile?: SecurityProfile;
  /** Absent where no shell serves the SDK; embedding it then fails closed. */
  readonly staticAuth?: StaticAuthRelease;
};

/**
 * One host per process, so it lives on the global object: a second copy of
 * this module (a test's module reset, a duplicated bundle) still sees the host
 * the shell installed.
 */
declare global {
  var __opensesameAppCoreHost: Host | undefined;
}

/**
 * A host from a shell's ports and its build: `rest` wins where both name a
 * field. Property descriptors are copied, not values, so a port read through
 * a getter (the browser's reads its global each time) stays live.
 */
export function composeHost(
  ports: Ports,
  rest: Omit<Host, keyof Ports> & Partial<Ports>,
): Host {
  const composed = Object.defineProperties(
    {},
    Object.getOwnPropertyDescriptors(ports),
  );
  // SAFETY: checked by the parameter types — `ports` carries only optional Host fields and `rest` carries `env`, the one required field, so the merged object satisfies the Host contract.
  return Object.defineProperties(
    composed,
    Object.getOwnPropertyDescriptors(rest),
  ) as Host;
}

/** Install the host. The shell calls this once, before loading the app. */
export function configureHost(next: Host): void {
  globalThis.__opensesameAppCoreHost = next;
}

/** The installed host; throws when the shell never installed one. */
export function host(): Host {
  const installed = globalThis.__opensesameAppCoreHost;
  if (!installed) {
    throw new Error(
      "app-core: no host installed — call configureHost() before using the core",
    );
  }
  return installed;
}

/** The shell's compiled capability artifacts; throws where none exist. */
export function capabilityArtifacts(): CapabilityArtifacts {
  const artifacts = host().capabilities;
  if (!artifacts) {
    throw new Error(
      "app-core: this host compiled in no capability modules or distribution",
    );
  }
  return artifacts;
}

/** The static-auth release this shell serves; throws where none is served. */
export function staticAuthRelease(): StaticAuthRelease {
  const release = host().staticAuth;
  if (!release) {
    throw new Error("app-core: this host serves no static-auth SDK release");
  }
  return release;
}

/** Shorthand for `host().env`. */
export function env(): RuntimeEnv {
  return host().env;
}
