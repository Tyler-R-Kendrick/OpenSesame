import type { RetiredCredentialResponse } from "@opensesame/app-core/lib/retired-credentials/index.js";
import type { GlobalFlags } from "./parse.js";

export type RetiredCredentialCommand =
  | { name: "vault-retired-status" | "vault-retired-clear"; flags: GlobalFlags }
  | {
      name: "vault-retired-enroll";
      response: RetiredCredentialResponse;
      flags: GlobalFlags;
    }
  | { name: "vault-retired-remove"; id: string; flags: GlobalFlags };

/** Human-only management: credentials never appear in arguments or environment. */
export function parseRetiredCredentials(
  args: string[],
  flags: GlobalFlags,
): RetiredCredentialCommand {
  const verb = args.shift();
  if (verb === "status" || verb === "clear") {
    if (args.length)
      throw new Error(`vault retired-credentials ${verb} takes no arguments`);
    return {
      name: verb === "status" ? "vault-retired-status" : "vault-retired-clear",
      flags,
    };
  }
  if (verb === "remove") {
    const id = args.shift();
    if (!id || args.length)
      throw new Error("vault retired-credentials remove requires one trap id");
    return { name: "vault-retired-remove", id, flags };
  }
  if (verb !== "enroll")
    throw new Error(
      "vault retired-credentials requires status, enroll, remove, or clear",
    );
  const acknowledgement = args.indexOf("--acknowledge-password-verifier-risk");
  if (acknowledgement < 0)
    throw new Error(
      "Enrollment requires --acknowledge-password-verifier-risk: retained verifiers allow offline guessing; legitimate stale passwords can trigger local-only evidence.",
    );
  args.splice(acknowledgement, 1);
  let response: RetiredCredentialResponse = "reject";
  const responseOption = args.indexOf("--response");
  if (responseOption >= 0) {
    const value = args[responseOption + 1];
    if (value !== "reject" && value !== "synthetic_decoy")
      throw new Error("--response must be reject or synthetic_decoy");
    response = value;
    args.splice(responseOption, 2);
  }
  if (args.length)
    throw new Error(
      "Retired passwords are read from the terminal only; enrollment takes no credential arguments.",
    );
  return { name: "vault-retired-enroll", response, flags };
}
