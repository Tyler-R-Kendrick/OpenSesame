/** Trusted local dispatch adapter. Detection metadata is never production authority. */
import {
  assertNotDecoySession,
  currentRealmGeneration,
} from "../decoy-session.js";
export function createControlledOperationResolver(tomb: string) {
  const realm = currentRealmGeneration();
  const assertCurrent = () => assertNotDecoySession(realm);
  return {
    async resolve(reference: string) {
      const reserved = reference.startsWith("oscanary:");
      if (!reserved) assertCurrent();
      const { observeControlledReference } = await import(
        "../credential-canaries/observe.js"
      );
      if (!reserved) assertCurrent();
      const decision = await observeControlledReference({
        tomb,
        reference,
        phase: "invoked",
      });
      if (decision.kind === "canary") return decision;
      if (reserved) return { kind: "reject" as const };
      assertCurrent();
      return { kind: "production" as const, assertCurrent };
    },
  };
}
