/** Durable MFA spending and legacy factor-binding upgrade after genuine configured factors. */
import {
  type VaultHeader,
  prepareFactorConfigurationBinding,
} from "@opensesame/vault-core";
import { kvRefresh } from "../kv.js";
import { readPagesRetiredCredentialHeader } from "../retired-credentials/context-v2-header.js";
import { BODY_PATH, HEADER_PATH, tombFileKey } from "../vfs.js";
import type { PhysicalAuthenticationSnapshot } from "./physical-authentication-port.js";
import type { PhysicalVaultPublicationReader } from "./physical-vault-publication-port.js";
import {
  manifestWithoutAuth,
  sealAuthenticatedManifest,
} from "./protection/manifest-auth.js";
async function bindChangedHeader(header: VaultHeader, root: Uint8Array) {
  const manifest = header.protection;
  if (!manifest) throw new Error("Original human root manifest is required.");
  const revision = manifest.revision + 1;
  if (!Number.isSafeInteger(revision))
    throw new Error("Manifest revision exhausted.");
  const next = {
    ...header,
    protection: { ...manifestWithoutAuth(manifest), revision },
  };
  const factorConfiguration = await prepareFactorConfigurationBinding(next);
  const protection = await sealAuthenticatedManifest(root, {
    ...next.protection,
    factorConfiguration,
  });
  return { ...next, protection };
}
export async function publishRetiredOwnerHeader(
  snapshot: PhysicalAuthenticationSnapshot,
  previous: VaultHeader,
  next: VaultHeader,
  root: Uint8Array,
  publication: PhysicalVaultPublicationReader,
  check: () => void,
  changed: (header: VaultHeader) => void,
) {
  if (next === previous && previous.protection?.factorConfiguration)
    return {
      snapshot,
      header: readPagesRetiredCredentialHeader(JSON.stringify(previous)),
    };
  const header = readPagesRetiredCredentialHeader(
    JSON.stringify(await bindChangedHeader(next, root)),
  );
  check();
  const headerText = JSON.stringify(header);
  const published = await publication.publishHeader(
    snapshot,
    headerText,
    check,
  );
  check();
  if (
    published.tomb !== snapshot.tomb ||
    published.header !== headerText ||
    published.body !== snapshot.body
  )
    throw new Error(
      "Original header publication returned a different snapshot.",
    );
  const accepted = Object.freeze({
    tomb: snapshot.tomb,
    header: headerText,
    body: snapshot.body,
  });
  await kvRefresh(tombFileKey(snapshot.tomb, HEADER_PATH), 65536, check);
  await kvRefresh(tombFileKey(snapshot.tomb, BODY_PATH), 8 << 20, check);
  check();
  changed(header);
  return { snapshot: accepted, header };
}
