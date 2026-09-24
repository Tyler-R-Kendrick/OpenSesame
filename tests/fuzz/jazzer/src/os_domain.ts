import { type Principal, assertPrincipalIdStable } from "@opensesame/os-domain";
import { FuzzedDataProvider } from "./provider.js";

export function fuzz(data: Buffer): void {
  const p = new FuzzedDataProvider(data);
  const id = p.consumeString(16) || "prn_1";
  const now = new Date(0);
  const before: Principal = {
    id,
    state: "provisional",
    assurance: "provisional",
    createdAt: now,
    updatedAt: now,
    version: 1,
  };
  const after: Principal = {
    id: p.consumeBoolean() ? id : `${id}-x`,
    state: "active",
    assurance: "verified",
    createdAt: now,
    updatedAt: now,
    version: 2,
  };
  try {
    assertPrincipalIdStable(before, after);
    if (before.id !== after.id) {
      throw new Error("principal id changed and was accepted");
    }
  } catch (err) {
    if (err instanceof Error && err.message.includes("accepted")) {
      throw err;
    }
  }
}
