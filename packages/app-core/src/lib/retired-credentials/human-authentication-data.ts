/** Fixed format dispatch of authenticated data only; no root input issues owner authority. */
import { z } from "zod";
import { verifyHumanVaultData } from "./human-vault-data.js";
import { verifyHumanVaultProjectionData } from "./human-vault-projection-data.js";
import { assertUnambiguousJson } from "./json-preflight.js";

const BODY_TEXT_LIMIT = Math.ceil((4 * 1024 * 1024) / 3) * 4 + 128;
const sealedBody = z.strictObject({ ivB64: z.string(), ctB64: z.string() });
export function verifyHumanAuthenticationData(
  tomb: string,
  header: string,
  wire: string,
  format: "flat-v1" | "node-projection-v1",
  root: Uint8Array,
) {
  if (format === "node-projection-v1")
    return verifyHumanVaultProjectionData(tomb, header, wire, root);
  if (format !== "flat-v1")
    throw new Error("Unsupported physical vault body format.");
  assertUnambiguousJson(wire, BODY_TEXT_LIMIT);
  return verifyHumanVaultData(
    tomb,
    header,
    sealedBody.parse(JSON.parse(wire)),
    root,
  );
}
