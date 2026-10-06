import {
  type CanaryArtifact,
  type ControlledValidatorBinding,
  type ControlledValidatorStoragePort,
  createControlledValidatorBinding,
  initializeControlledValidatorState,
} from "@opensesame/app-core/lib/credential-canaries/index.js";
import {
  kvDeleteDurable,
  kvGet,
  kvRefresh,
  kvSetDurable,
} from "@opensesame/app-core/lib/kv.js";
import { lockManager } from "@opensesame/app-core/ports.js";
/** Metadata-only, device-at-rest protected storage; no owner root or production connector. */
export function controlledDetectorStorage(
  binding: ControlledValidatorBinding,
): ControlledValidatorStoragePort {
  const key = `credential-canary-validator.v1.${binding.validatorId}`;
  return {
    transaction: async (work) => {
      const locks = lockManager();
      if (!locks)
        throw new Error("Validator storage requires durable process locking.");
      return locks.request(
        `opensesame.controlled-validator.${binding.validatorId}`,
        async () => {
          await kvRefresh(key, 32768);
          return work(kvGet(key), async (value) => {
            if (new TextEncoder().encode(value).length > 32768)
              throw new Error("Validator state exceeds its limit.");
            await kvSetDurable(key, value);
          });
        },
      );
    },
  };
}
export async function installControlledDetector(
  binding: ControlledValidatorBinding,
  artifact: CanaryArtifact,
): Promise<void> {
  const computed = await createControlledValidatorBinding(artifact);
  if (
    computed.artifactId !== binding.artifactId ||
    computed.digestB64 !== binding.digestB64 ||
    JSON.stringify(computed.context) !== JSON.stringify(binding.context)
  )
    throw new Error("Canary configuration binding is invalid.");
  await controlledDetectorStorage(binding).transaction(async (raw, save) => {
    if (raw !== null)
      throw new Error("Validator is already installed. It was not replaced.");
    await save(initializeControlledValidatorState(binding));
  });
}

export async function removeControlledDetector(
  binding: ControlledValidatorBinding,
): Promise<void> {
  const locks = lockManager();
  if (!locks)
    throw new Error("Validator storage requires durable process locking.");
  await locks.request(
    `opensesame.controlled-validator.${binding.validatorId}`,
    () =>
      kvDeleteDurable(`credential-canary-validator.v1.${binding.validatorId}`),
  );
}
