import type { WorkflowSecurity } from "./password-workflow-handoff";
export interface OriginalOwner {
  readonly permit: string | undefined;
  check(): void;
  authorize(): Promise<void>;
}
/** Capture once, before any await; a new real session cannot revive this work. */
function captureOperation(
  security: WorkflowSecurity,
  requiresOwner: boolean,
): OriginalOwner {
  const permit = security.permit();
  const check = () => {
    if ((requiresOwner && !permit) || security.permit() !== permit)
      throw new Error("The original vault session ended.");
  };
  check();
  return {
    permit,
    check,
    async authorize() {
      check();
      await security.requireProduction();
      check();
    },
  };
}
/** SDK retries/fallbacks must each retain the originating worker authority. */
export function ownerFetch(
  owner: OriginalOwner,
  fetchImpl: typeof fetch = fetch,
): typeof fetch {
  return async (input, init) => {
    await owner.authorize();
    owner.check();
    const response = await fetchImpl(input, init);
    try {
      owner.check();
      await owner.authorize();
      owner.check();
    } catch (error) {
      await response.body?.cancel();
      throw error;
    }
    return response;
  };
}
/** Check at actual storage dispatch as well as the SealedKv await boundary. */
export function ownerStore(
  raw: import("./store").RawStore,
  owner: OriginalOwner,
): import("./store").RawStore {
  return {
    async get(key) {
      owner.check();
      const value = await raw.get(key);
      owner.check();
      return value;
    },
    async set(key, value) {
      owner.check();
      await raw.set(key, value);
      owner.check();
    },
    async remove(key) {
      owner.check();
      await raw.remove(key);
      owner.check();
    },
    async keys() {
      owner.check();
      const keys = await raw.keys();
      owner.check();
      return keys;
    },
  };
}

/** Legacy no-vault pages stay unprotected only while the same undefined ticket remains. */
export function originalPageOperation(
  security: WorkflowSecurity,
): OriginalOwner {
  return captureOperation(security, false);
}
export function originalOwner(security: WorkflowSecurity): OriginalOwner {
  return captureOperation(security, true);
}
