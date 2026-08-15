import { createMemoryChallengeStore } from "@opensesame/auth-upstream";
import { FuzzedDataProvider } from "./provider.js";

export function fuzz(data: Buffer): void {
  const p = new FuzzedDataProvider(data);
  const store = createMemoryChallengeStore();
  const challenge = p.consumeString(32) || "chal";
  store.set(challenge, {
    principalId: null,
    expiresAt: Date.now() + 60_000,
    purpose: "authentication",
  });
  const first = store.consume(challenge);
  const second = store.consume(challenge);
  if (first !== undefined && second !== undefined) {
    throw new Error("challenge was reusable");
  }
}
