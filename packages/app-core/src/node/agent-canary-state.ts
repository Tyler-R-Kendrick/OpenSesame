/** Private authenticated receiver storage; this key never grants vault authority. */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import {
  ControlledCanaryEventSchema,
  ControlledCanaryHex,
  ControlledCanaryRecordSchema,
} from "../lib/agent-canaries/controlled-receiver-contract.js";
import {
  type CanaryPairing,
  CanaryPairingSchema,
} from "./agent-canary-receiver.js";
export const ReceiverStateSchema = z.strictObject({
  v: z.literal(1),
  serviceId: ControlledCanaryHex,
  records: z
    .array(
      z.strictObject({
        record: ControlledCanaryRecordSchema,
        token: ControlledCanaryHex,
      }),
    )
    .max(128),
  events: z.array(ControlledCanaryEventSchema).max(1024),
  sequence: z.number().int().nonnegative().safe(),
});
export type ReceiverState = z.infer<typeof ReceiverStateSchema>;
async function privateFile(path: string): Promise<Buffer> {
  // Open with O_NOFOLLOW first, then judge the descriptor. Checking a path
  // and opening it later is the race this used to have.
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const held = await file.stat();
    if (!held.isFile() || (held.mode & 0o077) !== 0 || held.size > 2 << 20)
      throw new Error("Receiver file must be private and regular.");
    return await file.readFile();
  } finally {
    await file.close();
  }
}
async function readReceiverState(
  path: string,
  key: Buffer,
  serviceId: string,
): Promise<ReceiverState> {
  let state: ReceiverState = {
    v: 1,
    serviceId,
    records: [],
    events: [],
    sequence: 0,
  };
  try {
    const wire = await privateFile(path);
    const decipher = createDecipheriv(
      "aes-256-gcm",
      key,
      wire.subarray(0, 12),
      {
        authTagLength: 16,
      },
    );
    decipher.setAAD(Buffer.from(serviceId));
    decipher.setAuthTag(wire.subarray(12, 28));
    state = ReceiverStateSchema.parse(
      JSON.parse(
        Buffer.concat([
          decipher.update(wire.subarray(28)),
          decipher.final(),
        ]).toString("utf8"),
      ),
    );
    if (state.serviceId !== serviceId)
      throw new Error("Foreign receiver state.");
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT"))
      throw error;
  }
  return state;
}
export async function openCanaryState(directory: string, serviceId: string) {
  ControlledCanaryHex.parse(serviceId);
  await mkdir(directory, { mode: 0o700, recursive: true });
  const stat = await lstat(directory);
  if (!stat.isDirectory() || (stat.mode & 0o077) !== 0)
    throw new Error("Receiver directory must be private.");
  const lock = await open(join(directory, "receiver.lock"), "wx", 0o600);
  try {
    const keyPath = join(directory, "receiver.key");
    try {
      const file = await open(keyPath, "wx", 0o600);
      try {
        await file.writeFile(randomBytes(32));
        await file.sync();
      } finally {
        await file.close();
      }
    } catch (error) {
      if (
        !(error instanceof Error && "code" in error && error.code === "EEXIST")
      )
        throw error;
    }
    const key = await privateFile(keyPath);
    if (key.length !== 32) throw new Error("Invalid receiver key.");
    const path = join(directory, "receiver.sealed");
    const state = await readReceiverState(path, key, serviceId);
    return {
      state,
      async save(next: ReceiverState) {
        const validated = ReceiverStateSchema.parse(next);
        if (validated.serviceId !== serviceId)
          throw new Error("Foreign receiver state.");
        const nonce = randomBytes(12);
        const cipher = createCipheriv("aes-256-gcm", key, nonce, {
          authTagLength: 16,
        });
        cipher.setAAD(Buffer.from(serviceId));
        const ciphertext = Buffer.concat([
          cipher.update(JSON.stringify(validated)),
          cipher.final(),
        ]);
        const temporary = `${path}.${randomBytes(16).toString("hex")}`;
        const file = await open(temporary, "wx", 0o600);
        try {
          await file.writeFile(
            Buffer.concat([nonce, cipher.getAuthTag(), ciphertext]),
          );
          await file.sync();
        } finally {
          await file.close();
        }
        await rename(temporary, path);
        const directoryHandle = await open(directory, "r");
        try {
          await directoryHandle.sync();
        } finally {
          await directoryHandle.close();
        }
      },
      async close() {
        key.fill(0);
        await lock.close();
        await unlink(join(directory, "receiver.lock"));
      },
    };
  } catch (error) {
    await lock.close();
    await unlink(join(directory, "receiver.lock"));
    throw error;
  }
}
export async function readPrivateCanaryPairing(
  path: string,
): Promise<CanaryPairing> {
  return CanaryPairingSchema.parse(
    JSON.parse((await privateFile(path)).toString("utf8")),
  );
}
