/** Checked retired record effects, kept inside the original private Store's accepted producer. */
import type { VaultHeader } from "@opensesame/vault-core";
import { readPagesRetiredCredentialHeader } from "../retired-credentials/context-v2-header.js";
import { refuseCurrentPasswordRecords } from "../retired-credentials/current-password-collision.js";
import { matchDeviceRetiredCredentialData } from "../retired-credentials/device-global-match-data.js";
import { projectRetiredCredentialInspection } from "../retired-credentials/inspection-v2.js";
import { prepareRetiredRecordChange } from "../retired-credentials/record-change-v2.js";
import { disposeOriginalCommandData } from "./original-command-retirement-data.js";
import type { PhysicalAuthenticationSnapshot } from "./physical-authentication-port.js";
import type { PhysicalDeviceRecordReader } from "./physical-device-record-port.js";
import type { RetiredCommand } from "./retired-operation-exchange.js";
import type { captureRetiredOwnerResources } from "./retired-owner-resources.js";

import {
  captureRetiredCatalogueReaderIdentity,
  captureRetiredScopeReaderIdentity,
} from "./retired-owner-reader-identity.js";

type Resources = ReturnType<typeof captureRetiredOwnerResources>;
async function refuseForeignCurrent(
  resources: Resources,
  tomb: string,
  candidate: string,
  identity: string,
) {
  const catalogue = await resources.catalogue.capture(resources.check);
  let failure: ErrorOptions | undefined;
  try {
    resources.retainReaderIdentity(
      captureRetiredCatalogueReaderIdentity(catalogue),
    );
    const snapshot = await catalogue.read();
    if (snapshot.physicalIdentity !== identity)
      throw new Error("Original catalogue root differs.");
    for (const row of snapshot.scopes) {
      if (row.tomb === tomb) continue;
      await resources.withBody(row.tomb, async () => {
        const scope = await catalogue.captureScope(row, resources.check);
        let scopeFailure: ErrorOptions | undefined;
        try {
          resources.retainReaderIdentity(
            captureRetiredScopeReaderIdentity(scope),
          );
          const data = await scope.read();
          if (data.kind === "deleted") {
            await scope.revalidate(data);
            resources.check();
            return;
          }
          const headerText = data.header;
          const bodyText = data.body;
          const bodyFormat = data.bodyFormat;
          const header = readPagesRetiredCredentialHeader(headerText);
          await refuseCurrentPasswordRecords(
            row.tomb,
            headerText,
            header,
            { format: bodyFormat, wire: bodyText },
            "",
            candidate,
            resources.check,
          );
          await scope.revalidate(data);
          if (
            data.header !== headerText ||
            data.body !== bodyText ||
            data.bodyFormat !== bodyFormat
          )
            throw new Error(
              "Original foreign authentication snapshot changed.",
            );
          resources.check();
        } catch (cause) {
          scopeFailure = { cause };
          throw cause;
        } finally {
          await disposeOriginalCommandData(
            scopeFailure,
            resources.recordDrainFailure,
            [scope.close],
          );
        }
      });
    }
    await catalogue.revalidate(snapshot);
    resources.check();
  } catch (cause) {
    failure = { cause };
    throw cause;
  } finally {
    await disposeOriginalCommandData(failure, resources.recordDrainFailure, [
      catalogue.close,
    ]);
  }
}
export interface RetiredManagementEffectInput {
  resources: Resources;
  device: PhysicalDeviceRecordReader;
  snapshot: PhysicalAuthenticationSnapshot;
  header: VaultHeader;
  bodyFormat: "flat-v1" | "node-projection-v1";
  rootCommitment: string;
  identity: string;
  contextWire: string;
  command: RetiredCommand;
  refuseDuress: (candidate: string) => Promise<void>;
  revalidateDuress: () => Promise<void>;
}
export async function runRetiredManagementEffects(
  input: RetiredManagementEffectInput,
) {
  const {
    resources,
    device,
    snapshot,
    header,
    bodyFormat,
    rootCommitment,
    identity,
    contextWire,
    command,
    refuseDuress,
    revalidateDuress,
  } = input;
  const check = resources.check;
  const key = `tomb/${snapshot.tomb}/retired-credentials.v2`;
  const raw = await device.read(key, 32768);
  check();
  if (command.kind === "inspect")
    return projectRetiredCredentialInspection(raw, contextWire);
  if (command.change.type === "enroll") {
    if (!snapshot.header || !snapshot.body)
      throw new Error("Original authentication changed.");
    const candidate = command.change.password;
    await refuseCurrentPasswordRecords(
      snapshot.tomb,
      snapshot.header,
      header,
      { format: bodyFormat, wire: snapshot.body },
      rootCommitment,
      candidate,
      check,
    );
    await refuseForeignCurrent(resources, snapshot.tomb, candidate, identity);
    if (
      (await matchDeviceRetiredCredentialData(device, candidate, check)).length
    )
      throw new Error(
        "That retired credential is already retained on this device.",
      );
    await refuseDuress(candidate);
    check();
  }
  const next = await prepareRetiredRecordChange(
    raw,
    contextWire,
    command.change,
    check,
  );
  check();
  await revalidateDuress();
  await device.publish(key, raw, next, 32768, check);
  await revalidateDuress();
  check();
  if ((await device.read(key, 32768)) !== next)
    throw new Error("Retired record readback changed.");
  check();
  return projectRetiredCredentialInspection(next, contextWire);
}
