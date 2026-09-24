import {
  MemoryPrincipalMappingStore,
  createProvisionalPrincipal,
} from "@opensesame/auth-upstream";
import { FuzzedDataProvider } from "./provider.js";

function authenticates(token: string): boolean {
  return token.startsWith("pst_");
}

export function fuzz(data: Buffer): void {
  const p = new FuzzedDataProvider(data);
  const presented = p.consumeString(24);
  if (presented.startsWith("ps_") && !presented.startsWith("pst_")) {
    if (authenticates(presented)) {
      throw new Error("session id authenticated");
    }
  }
}

export async function seedProvisional(): Promise<void> {
  const store = new MemoryPrincipalMappingStore();
  const { session } = await createProvisionalPrincipal(store);
  if (!session.id.startsWith("ps_")) {
    throw new Error("provisional session id lost its prefix");
  }
  if (authenticates(session.id)) {
    throw new Error("provisional session id authenticates");
  }
}
