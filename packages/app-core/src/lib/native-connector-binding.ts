/** Retained driver closures belong to the activation that installed them. */
import type { NativeConnectorDriver } from "./native-connector-drivers.js";
import type { NativeProviderTransport } from "./native-connector-transport.js";

export function bindNativeConnectorDriver(
  driver: NativeConnectorDriver,
  transport: Pick<NativeProviderTransport, "assertCurrent">,
): NativeConnectorDriver {
  const guard = async <T>(
    action: () => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> => {
    transport.assertCurrent();
    signal?.throwIfAborted();
    const result = await action();
    signal?.throwIfAborted();
    transport.assertCurrent();
    return result;
  };
  const cleanup = driver.cleanup;
  return {
    supports: driver.supports,
    configure: (input) => guard(() => driver.configure(input)),
    verify: (id) => guard(() => driver.verify(id)),
    invoke: (id, operation, input, signal) =>
      guard(
        () =>
          signal === undefined
            ? driver.invoke(id, operation, input)
            : driver.invoke(id, operation, input, signal),
        signal,
      ),
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
      capture: cleanup.capture
        ? (id) => {
            transport.assertCurrent();
            const captured = cleanup.capture?.(id);
            transport.assertCurrent();
            if (!captured) throw new Error("Provider cleanup capture changed");
            return captured;
          }
        : undefined,
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
        ? (id, original) =>
            guard(() => {
              if (!cleanup.prepare) return Promise.resolve();
              return original === undefined
                ? cleanup.prepare(id)
                : cleanup.prepare(id, original);
            })
        : undefined,
      finalize: cleanup.finalize
        ? (id, original) =>
            guard(() => {
              if (!cleanup.finalize) return Promise.resolve();
              return original === undefined
                ? cleanup.finalize(id)
                : cleanup.finalize(id, original);
            })
        : undefined,
      cleanup: (obligation, context) =>
        guard(() => cleanup.cleanup(obligation, context)),
    },
  };
}
