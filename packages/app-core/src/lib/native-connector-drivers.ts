import type { NativeProviderCleanup } from "./native-connector-lifecycle.js";
/** Driver registration is owned by one capability activation, never by importing a form. */
import type { NativeMethod } from "./native-connector-schema.js";
import type { NativeConnectorView } from "./native-connector-view.js";

export type NativeDriverInput = {
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
  verify: (connectionId: string) => Promise<NativeConnectorView>;
  authorize?: (connectionId: string, actor?: string) => Promise<void>;
  invoke: (
    connectionId: string,
    operationId: string,
    input: Record<string, string>,
  ) => Promise<NativeDriverResult>;
};

const drivers = new Map<NativeMethod, NativeConnectorDriver>();

export function registerNativeConnectorDriver(
  method: NativeMethod,
  driver: NativeConnectorDriver,
): () => void {
  if (drivers.has(method))
    throw new Error("Native provider driver is already active");
  drivers.set(method, driver);
  return () => {
    if (drivers.get(method) === driver) drivers.delete(method);
  };
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
