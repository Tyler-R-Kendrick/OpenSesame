import {
  type OriginalOwner,
  originalPageOperation,
  ownerStore,
} from "./original-owner";
import type { WorkflowSecurity } from "./password-workflow-handoff";
import { RunnerSettings } from "./settings";
import { type RawStore, SealedKv } from "./store";
import { RunnerVault } from "./vault";
function scope(raw: RawStore, owner: OriginalOwner) {
  const kv = new SealedKv(ownerStore(raw, owner), undefined, owner.authorize);
  return { settings: new RunnerSettings(kv), vault: new RunnerVault(kv) };
}
/** Every settings event owns one ticket, including its success/error continuation. */
export function pageOperations(view: {
  security: WorkflowSecurity;
  raw(): RawStore;
  say(text: string): void;
}) {
  return async (
    action: (
      owner: OriginalOwner,
      scoped: ReturnType<typeof scope>,
    ) => Promise<void>,
    error?: string,
    originating?: OriginalOwner,
  ) => {
    const owner = originating ?? originalPageOperation(view.security);
    try {
      await owner.authorize();
      owner.check();
      await action(owner, scope(view.raw(), owner));
    } catch {
      try {
        owner.check();
        await owner.authorize();
        owner.check();
        if (error) view.say(error);
      } catch {
        /* Stale work must not alter a successor's UI. */
      }
    }
  };
}
