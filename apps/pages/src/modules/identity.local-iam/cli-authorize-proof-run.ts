import type { CliAuthorizeRow } from "./cli-authorize-mint-proof.js";
import { CliAuthorizeRefusal } from "./cli-authorize-mint-proof.js";

const PROOF_OFFLINE = "Authorize needs a connection to load on this device.";

export async function runCliAuthorizePasskeyApprove(input: {
  row: CliAuthorizeRow;
  busy: boolean;
  setBusy: (busy: boolean) => void;
  setMark: (mark: string | null) => void;
  finish: (decision: "approve" | "deny", humanProof?: string) => Promise<void>;
}): Promise<void> {
  if (input.busy) return;
  input.setBusy(true);
  input.setMark(null);
  let mint: typeof import("./cli-authorize-mint-proof.js");
  try {
    mint = await import("./cli-authorize-mint-proof.js");
  } catch {
    input.setBusy(false);
    input.setMark(PROOF_OFFLINE);
    return;
  }
  try {
    const proof = await mint.mintCliAuthorizePasskeyProof(input.row);
    input.setBusy(false);
    await input.finish("approve", proof);
  } catch (error) {
    input.setBusy(false);
    input.setMark(
      error instanceof CliAuthorizeRefusal
        ? error.message
        : "The passkey step did not finish.",
    );
  }
}
