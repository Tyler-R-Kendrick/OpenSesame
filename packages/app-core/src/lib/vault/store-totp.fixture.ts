/** Test support: enroll an authenticator on a store the way a person would. */
import { parseTotp, totpCode } from "@opensesame/vault-core";
import type { VaultStore } from "./store.js";

/** Begin, compute the current code from the setup URI, confirm; the URI. */
export async function enrollTotp(store: VaultStore): Promise<string> {
  const uri = await store.beginTotpEnrollment();
  const secret = new URL(uri).searchParams.get("secret") ?? "";
  await store.confirmTotpEnrollment(await totpCode(parseTotp(secret)));
  return uri;
}
