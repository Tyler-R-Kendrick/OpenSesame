import type { ExtensionRealmBroker } from "@opensesame/app-core/browser/security/broker.js";
import type { OriginalOwner } from "./original-owner";
export class RunnerAuthorityEnded extends Error {
  constructor() {
    super("The original runner owner session ended.");
    this.name = "RunnerAuthorityEnded";
  }
}
export interface RunnerOwner extends OriginalOwner {
  owns(origin: string): boolean;
}
/** Each callback retains the exact original broker lease and arm record. */
export function runnerOwner(
  broker: ExtensionRealmBroker,
  permit: string | undefined,
  origin: string | undefined,
  retained: () => boolean,
): RunnerOwner {
  let witness: { check(): void };
  try {
    witness = broker.pin(permit);
  } catch {
    throw new RunnerAuthorityEnded();
  }
  let ended = false;
  const check = () => {
    try {
      if (ended) throw new RunnerAuthorityEnded();
      witness.check();
      if (!retained()) throw new RunnerAuthorityEnded();
    } catch {
      ended = true;
      throw new RunnerAuthorityEnded();
    }
  };
  return {
    permit,
    check,
    owns: (candidate) => origin === undefined || candidate === origin,
    async authorize() {
      check();
      try {
        if (!(await broker.allows(permit))) throw new RunnerAuthorityEnded();
        check();
      } catch {
        ended = true;
        throw new RunnerAuthorityEnded();
      }
    },
  };
}
/** Recheck synchronously after the await before invoking physical I/O. */
export async function ownedIO<T>(
  owner: OriginalOwner | undefined,
  action: () => Promise<T>,
  retireReturned?: (result: T) => Promise<unknown>,
): Promise<T> {
  if (owner) {
    owner.check();
    await owner.authorize();
    owner.check();
  }
  const result = await action();
  try {
    if (owner) {
      owner.check();
      await owner.authorize();
      owner.check();
    }
    return result;
  } catch (error) {
    // Only a resource created/returned by THIS call; never query successor state.
    if (retireReturned) await retireReturned(result).catch(() => undefined);
    throw error;
  }
}
