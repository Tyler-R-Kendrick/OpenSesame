import { listRetiredLeaseIdentifiers } from "@opensesame/app-core/lib/capabilities/lease-canary-issuer.js";
import {
  type OwnerProof,
  clearControlledCanaryEvents,
  createControlledCanary,
  exportControlledMcpConfiguration,
  listControlledCanaries,
  removeControlledCanary,
  retireIssuedIdentifier,
} from "@opensesame/app-core/lib/credential-canaries/index.js";
import { parseCanaryConfiguration } from "./canary-config.js";
import { installControlledDetector } from "./canary-detector.js";
import {
  assertCanaryExportOutputFits,
  cliCanaryServer,
} from "./canary-export-template.js";
import { emit } from "./output.js";
import type { SecurityCommand } from "./parse-security.js";
import { writeSecurityFile } from "./security-files.js";
import { withSecurityOwner } from "./security-owner.js";
import type { VaultItemDependencies } from "./vault-items.js";

type CanaryCommand = Extract<
  SecurityCommand,
  { name: `security-canary-${string}` }
>;
/** Fresh supported human owner proof for every mutation; no agent management surface. */
type ExportCommand = Extract<
  CanaryCommand,
  { name: "security-canary-create" | "security-canary-export" }
>;
async function exportCanary(
  command: ExportCommand,
  proof: OwnerProof,
): Promise<number> {
  const artifact = await createControlledCanary({
    ...proof,
    kind:
      command.name === "security-canary-export"
        ? "mcp_configuration"
        : command.kind,
  });
  try {
    const exported =
      command.name === "security-canary-export"
        ? await exportControlledMcpConfiguration({
            ...proof,
            artifact,
            suppliedValidatorRef: "human_cli_stdio",
          })
        : artifact;
    if (command.name === "security-canary-export" && "mcpServers" in exported) {
      exported.mcpServers.OpenSesameCanary = cliCanaryServer(command.output);
      parseCanaryConfiguration(`${JSON.stringify(exported, null, 2)}\n`);
    }
    await writeSecurityFile(command.output, exported);
    if ("validatorBinding" in exported)
      await installControlledDetector(exported.validatorBinding, artifact);
  } catch (error) {
    await removeControlledCanary({ ...proof, artifactId: artifact.id });
    throw error;
  }
  emit(
    command.flags,
    "Created controlled canary. Its one-time configuration was written to the owner-only file.",
    {
      ok: true,
      artifactId: artifact.id,
      kind: artifact.context.kind,
      output: command.output,
    },
  );
  return 0;
}
export async function runSecurityCanary(
  command: CanaryCommand,
  deps: VaultItemDependencies = {},
): Promise<number> {
  if (command.name === "security-canary-export")
    assertCanaryExportOutputFits(command.output);
  return withSecurityOwner(
    command.name !== "security-canary-status",
    deps,
    async (proof) => {
      if (
        command.name === "security-canary-create" ||
        command.name === "security-canary-export"
      )
        return exportCanary(command, proof);
      if (command.name === "security-canary-remove")
        await removeControlledCanary({
          ...proof,
          artifactId: command.artifactId,
        });
      if (command.name === "security-canary-clear")
        await clearControlledCanaryEvents(proof);
      if (command.name === "security-canary-retire")
        await retireIssuedIdentifier({
          ...proof,
          issuerRecordRef: command.issuerRecordRef,
        });
      const status = await listControlledCanaries(proof.tomb);
      emit(
        command.flags,
        `${status.artifacts.length} controlled canaries; ${status.events.length} local observations.`,
        {
          ok: true,
          localOnly: true,
          ...status,
          retiredIssuerInventory: listRetiredLeaseIdentifiers(proof.tomb),
          issuerInventoryScope: "current-runtime-only",
        },
      );
      return 0;
    },
  );
}
