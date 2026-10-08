import { listInstalledControlledValidatorEvents } from "@opensesame/app-core/lib/credential-canaries/index.js";
import { defaultStateDir } from "@opensesame/app-core/node/host.js";
import { parseCanaryConfiguration } from "./canary-config.js";
import {
  controlledDetectorStorage,
  installControlledDetector,
  removeControlledDetector,
} from "./canary-detector.js";
import { emit } from "./output.js";
import type { SecurityCommand } from "./parse-security.js";
import { readSecurityFile } from "./security-files.js";
import { releaseVaultKv, useVaultKv } from "./vault-kv.js";
type Command = Extract<
  SecurityCommand,
  { name: "canary-install" | "canary-uninstall" | "canary-events" }
>;
/** Explicitly install only a private synthetic detector; this cannot enroll real vault authority. */
export async function runCanaryInstallation(
  command: Command,
  stateDir = defaultStateDir(),
): Promise<number> {
  const config = parseCanaryConfiguration(
    await readSecurityFile(command.configFile, 4096),
  );
  if (!config.validatorBinding)
    throw new Error(
      "This exported file has no independently installable validator binding.",
    );
  await useVaultKv(stateDir);
  try {
    if (command.name === "canary-install")
      await installControlledDetector(config.validatorBinding, config.artifact);
    if (command.name === "canary-uninstall")
      await removeControlledDetector(config.validatorBinding);
    const events =
      command.name === "canary-events"
        ? await listInstalledControlledValidatorEvents(
            config.validatorBinding,
            controlledDetectorStorage(config.validatorBinding),
          )
        : undefined;
    emit(
      command.flags,
      command.name === "canary-install"
        ? "Installed a local synthetic detector. Configure your MCP client with this file; evidence is local to this CLI environment."
        : command.name === "canary-uninstall"
          ? "Removed the local detector. Its old configuration now fails closed."
          : `${events?.length ?? 0} local detector observations.`,
      {
        ok: true,
        validatorId: config.validatorBinding.validatorId,
        localOnly: true,
        events,
      },
    );
    return 0;
  } finally {
    await releaseVaultKv();
  }
}
