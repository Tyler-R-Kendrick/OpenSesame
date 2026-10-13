/** Current real-auth collision check only; does not create authority or normalize traps. */
import {
  type SealedBlob,
  type VaultHeader,
  WrongPasswordError,
  importVaultKey,
  unwrapRawVaultKeyFromPassword,
} from "@opensesame/vault-core";
import { z } from "zod";
import { sessionRootDigestFromKey } from "../duress/store/vault-session-digest.js";
import {
  pinPolicyProblems,
  unwrapVaultKeyWithPin,
} from "../vault/unlock-factor-crypto.js";
import { verifyHumanAuthenticationData } from "./human-authentication-data.js";
const collisionBody = z.union([
  z.strictObject({ ivB64: z.string(), ctB64: z.string() }),
  z.strictObject({
    format: z.enum(["flat-v1", "node-projection-v1"]),
    wire: z.string(),
  }),
]);
function unavailable(): never {
  throw new Error("Fresh password authentication is unavailable.");
}
async function refuseCurrentPin(
  header: VaultHeader,
  candidate: string,
  original: () => void,
  refuseOpenedRoot: (root: Uint8Array) => Promise<void>,
) {
  const pin = header.unlocks?.pin;
  if (pin && pinPolicyProblems(candidate).length === 0) {
    let root: Uint8Array | undefined;
    try {
      original();
      try {
        root = await unwrapVaultKeyWithPin(pin, candidate);
      } catch (error) {
        original();
        if (!(error instanceof WrongPasswordError)) throw error;
      }
      original();
      if (root) await refuseOpenedRoot(root);
    } finally {
      root?.fill(0);
    }
  }
}
/** Header/body/root commitment come from the private attempt's actual prior proof. */
export async function refuseCurrentPasswordRecords(
  tomb: string,
  headerText: string,
  header: VaultHeader,
  body:
    | SealedBlob
    | Readonly<{ format: "flat-v1" | "node-projection-v1"; wire: string }>,
  rootCommitment: string,
  candidate: string,
  original: () => void,
): Promise<void> {
  original();
  const parsed = collisionBody.parse(body);
  const data =
    "wire" in parsed
      ? parsed
      : { format: "flat-v1" as const, wire: JSON.stringify(parsed) };
  const refuseOpenedRoot = async (root: Uint8Array) => {
    await verifyHumanAuthenticationData(
      tomb,
      headerText,
      data.wire,
      data.format,
      root,
    );
    original();
    const key = await importVaultKey(root);
    original();
    const commitment = await sessionRootDigestFromKey(key, false);
    original();
    if (commitment !== rootCommitment) unavailable();
    // Actual current wrap + full manifest MAC + BODY/root proof is a collision.
    unavailable();
  };
  const passwords = header.protection?.records.filter(
    (record) => record.kind === "password",
  );
  if (!passwords || passwords.length > 64) unavailable();
  for (const selected of passwords) {
    let root: Uint8Array | undefined;
    try {
      original();
      try {
        root = await unwrapRawVaultKeyFromPassword(
          {
            v: 1,
            createdAt: header.createdAt,
            kdf: selected.kdf,
            wrap: selected.wrap,
          },
          candidate,
        );
      } catch (error) {
        original();
        if (error instanceof WrongPasswordError) continue;
        throw error;
      }
      original();
      await refuseOpenedRoot(root);
    } finally {
      root?.fill(0);
    }
  }
  await refuseCurrentPin(header, candidate, original, refuseOpenedRoot);
  original();
}
