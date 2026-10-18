/** Original native physical DATA ports. Private Store alone proves owner/factor/root authority. */
import { createHash } from "node:crypto";
import type { PhysicalDeviceRecordPort } from "@opensesame/app-core/lib/vault/physical-device-record-port.js";
import {
  bytes,
  deviceName,
  key,
  publishDevice,
  readDevice,
  unavailable,
} from "./native-vault-data.js";

import type { NativeVaultContext } from "./native-vault-context.js";
import { inventoryNames, releaseInventory } from "./native-vault-inventory.js";

export function devicePort({ native, capture }: NativeVaultContext) {
  const device: PhysicalDeviceRecordPort = {
    async capture(original) {
      const held = capture(original, undefined, true);
      return {
        ...held,
        async read(logical, bound) {
          held.check();
          const value = await readDevice(held.process, logical, bound);
          held.check();
          return value.value;
        },
        async publish(logical, expected, next, bound, publicationCheck) {
          if (
            !native.custody().writer ||
            !native.custody().credential ||
            logical.startsWith("duress.")
          )
            unavailable();
          await releaseInventory(native.custody().credential);
          await publishDevice(
            held.process,
            logical,
            expected,
            next,
            bound,
            () => {
              held.check();
              publicationCheck?.();
            },
          );
        },
        async captureRetiredCredentialInventory() {
          const credential = native.custody().credential;
          if (!credential) unavailable();
          const names = await inventoryNames(credential);
          const records = [];
          for (const tomb of names) {
            const ciphertext = bytes(
              await credential.request({ kind: "read_retired", tomb }),
            );
            if (ciphertext === null) continue;
            const logical = `tomb/${tomb}/retired-credentials.v2`;
            // The native inventory verifies outer AEAD. Decode through the same binding as selected reads.
            const { openAtRest, atRestBinding } = await import(
              "@opensesame/app-core/lib/at-rest/cipher.js"
            );
            const physicalName = deviceName(logical);
            const wire = openAtRest(
              await key(),
              atRestBinding(
                "node-device-record-v1",
                JSON.stringify([logical, physicalName]),
              ),
              new TextDecoder("utf-8", { fatal: true }).decode(ciphertext),
            );
            if (wire === null || Buffer.byteLength(wire) > 32768) unavailable();
            records.push(
              Object.freeze({
                tomb,
                wire,
                physicalName,
                ciphertextDigest: createHash("sha256")
                  .update(ciphertext)
                  .digest("hex"),
              }),
            );
          }
          held.check();
          await credential.request({ kind: "validate" });
          return Object.freeze(records);
        },
      };
    },
  };

  return device;
}
