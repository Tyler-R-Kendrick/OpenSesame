/** Retained driver closures belong to the activation that installed them. */
import type { NativeConnectorDriver } from "./native-connector-drivers.js";
import type { NativeProviderTransport } from "./native-connector-transport.js";

export function bindNativeConnectorDriver(
  driver: NativeConnectorDriver,
  transport: NativeProviderTransport,
): NativeConnectorDriver {
  const guard = async <T>(action: () => Promise<T>): Promise<T> => {
    transport.assertCurrent();
    const result = await action();
    transport.assertCurrent();
    return result;
  };
  const cleanup = driver.cleanup;
  return {
    supports: driver.supports,
    configure: (input) => guard(() => driver.configure(input)),
    verify: (id) => guard(() => driver.verify(id)),
    invoke: (id, operation, input) =>
      guard(() => driver.invoke(id, operation, input)),
    authorize: driver.authorize
      ? (id, actor) =>
          guard(() =>
            driver.authorize
              ? driver.authorize(id, actor)
              : Promise.reject(
                  new Error("Provider authorization is unavailable"),
                ),
          )
      : undefined,
    cleanup: {
      classification: (configuration) => {
        transport.assertCurrent();
        return cleanup.classification(configuration);
      },
      credentialSlots: (configuration, grant) => {
        transport.assertCurrent();
        const slots = cleanup.credentialSlots;
        return slots && "call" in slots
          ? slots(configuration, grant)
          : (slots ?? []);
      },
      prepare: cleanup.prepare
        ? (id) =>
            guard(() =>
              cleanup.prepare ? cleanup.prepare(id) : Promise.resolve(),
            )
        : undefined,
      cleanup: (obligation, context) =>
        guard(() => cleanup.cleanup(obligation, context)),
    },
  };
}
