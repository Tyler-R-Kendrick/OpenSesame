/** One arm/disarm/public-authentication commit turn per vault and across tabs. */
import { withVfsCrossTabLock } from "../vfs-cross-tab-lock.js";

const operations = new Map<string, Promise<unknown>>();

export function withDeadmanTurn<T>(
  tomb: string,
  run: () => Promise<T>,
): Promise<T> {
  return withVfsCrossTabLock(`opensesame:deadman:${tomb}`, () => {
    const previous = operations.get(tomb) ?? Promise.resolve();
    const next = previous.then(run, run);
    operations.set(
      tomb,
      next.then(
        () => undefined,
        () => undefined,
      ),
    );
    return next;
  });
}
