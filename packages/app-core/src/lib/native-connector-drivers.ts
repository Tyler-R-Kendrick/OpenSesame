import type { NativeProviderCleanup } from "./native-connector-lifecycle.js";
/** Driver registration is owned by one capability activation, never by importing a form. */
import type { NativeMethod } from "./native-connector-schema.js";
import type { NativeConnectorView } from "./native-connector-view.js";

export type NativeConfigurationOwner = Readonly<{
  signal: AbortSignal;
  assertCurrent(): void;
}>;

export type NativeDriverInput = {
  /** Transient mounted caller authority; never copied into saved configuration. */
  owner?: NativeConfigurationOwner;
  providerId: string;
  connectionId?: string;
  revision?: number;
  displayName: string;
  icon?: string;
  method: NativeMethod;
  parameters: Record<string, string>;
  credentials: Record<string, string>;
  requestedScopes: Record<string, string[]>;
  targetIds: Record<string, string>;
};

export type NativeDriverResult = {
  label: string;
  items: readonly {
    id: string;
    label: string;
    url?: string;
    inputSchema?: string;
    secretValue?: string;
  }[];
};

export type NativeConnectorDriver = {
  cleanup: NativeProviderCleanup;
  supports: (providerId: string) => boolean;
  configure: (input: NativeDriverInput) => Promise<NativeConnectorView>;
  /** Prove a credential against its provider and save nothing. */
  test?: (input: NativeDriverInput) => Promise<{ label: string }>;
  verify: (connectionId: string) => Promise<NativeConnectorView>;
  authorize?: (connectionId: string, actor?: string) => Promise<void>;
  invoke: (
    connectionId: string,
    operationId: string,
    input: Record<string, string>,
    signal?: AbortSignal,
  ) => Promise<NativeDriverResult>;
};

const drivers = new Map<NativeMethod, NativeConnectorDriver>();
/**
 * Methods whose owning runtime released its driver. A withdrawn capability
 * closes its road even though the compiled contract remains; a session that
 * never activated the runtime leaves the road to the compiled contract alone
 * (ADR 0142 withdrawal, ADR 0147 compiled availability).
 */
const withdrawn = new Set<NativeMethod>();

export function registerNativeConnectorDriver(
  method: NativeMethod,
  driver: NativeConnectorDriver,
): () => void {
  if (drivers.has(method))
    throw new Error("Native provider driver is already active");
  drivers.set(method, driver);
  withdrawn.delete(method);
  return () => {
    if (drivers.get(method) === driver) {
      drivers.delete(method);
      withdrawn.add(method);
    }
  };
}

/** Whether this method's runtime was activated and then taken away. */
export function nativeConnectorWithdrawn(method: NativeMethod): boolean {
  return withdrawn.has(method);
}

/** A fresh session (a new page load, a test) has no activation history. */
export function resetNativeConnectorDrivers(): void {
  drivers.clear();
  withdrawn.clear();
}

export function hasNativeConnectorDriver(
  method: NativeMethod,
  providerId: string,
): boolean {
  return drivers.get(method)?.supports(providerId) === true;
}

export function nativeConnectorDriver(
  method: NativeMethod,
  providerId: string,
): NativeConnectorDriver {
  const driver = drivers.get(method);
  if (!driver?.supports(providerId))
    throw new Error(
      "This provider route is unavailable in the active browser runtime",
    );
  return driver;
}
