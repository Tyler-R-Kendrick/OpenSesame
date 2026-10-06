import { CREDENTIAL_TYPE_IDS } from "@opensesame/vault-core";
import { resetPackStateForTests, setStatus } from "./state.js";

/**
 * Credential types switched on, as Settings › Vaults › Item types does (ADR
 * 0177). Returns the undo.
 */
export function switchCredentialPacksOn(): () => void {
  for (const id of CREDENTIAL_TYPE_IDS) setStatus(id, { phase: "on" });
  return resetPackStateForTests;
}
