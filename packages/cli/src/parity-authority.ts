import {
  assertNotDecoySession,
  withRealAuthority,
} from "@opensesame/app-core/lib/decoy-session.js";

/** Bind an effect to its originating real session, including a later real successor. */
export function parityAuthority(): () => void {
  const generation = assertNotDecoySession();
  return () => {
    assertNotDecoySession(generation);
  };
}

export function guardedEffect<A extends unknown[], T>(
  effect: (...args: A) => Promise<T>,
  originating?: () => void,
): (...args: A) => Promise<T> {
  return async (...args) => {
    const check = originating ?? parityAuthority();
    check();
    return withRealAuthority(async () => {
      const result = await effect(...args);
      check();
      return result;
    });
  };
}
