import {
  type ApplyChange,
  type BodyHost,
  type VaultBodyPort,
  makeBodyPort,
} from "./store-device-key.js";

/** Retained identity/restore callbacks never borrow a successor store's authority. */
export function makeGuardedBodyPort(
  host: BodyHost & { assertCurrent(): void },
): VaultBodyPort {
  const read =
    <T>(value: () => T): (() => T) =>
    () => {
      host.assertCurrent();
      return value();
    };
  return makeBodyPort({
    tomb: read(host.tomb),
    open: read(host.open),
    carries: read(host.carries),
    header: read(host.header),
    body: read(host.body),
    exclusive: <T>(act: (apply: ApplyChange) => Promise<T>): Promise<T> => {
      host.assertCurrent();
      return host.exclusive(async (apply) => {
        host.assertCurrent();
        const value = await act((change) => {
          host.assertCurrent();
          return apply(change);
        });
        host.assertCurrent();
        return value;
      });
    },
  });
}
