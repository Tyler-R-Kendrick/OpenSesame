import type {
  PhysicalCurrentCredentialCataloguePort,
  PhysicalCurrentCredentialCatalogueSnapshot,
  PhysicalCurrentCredentialScope,
  PhysicalCurrentCredentialScopeReader,
  PhysicalCurrentCredentialScopeSnapshot,
} from "@opensesame/app-core/lib/vault/physical-current-credential-catalogue.js";
import type { NativeVaultContext } from "./native-vault-context.js";
import { identity, snapshot, unavailable } from "./native-vault-data.js";
import { inventoryNames } from "./native-vault-inventory.js";
function scopeEntry(
  scope: PhysicalCurrentCredentialScope,
  current: Awaited<ReturnType<typeof snapshot>>,
): PhysicalCurrentCredentialScopeSnapshot {
  if (current.deleted)
    return {
      ...scope,
      kind: "deleted",
      marker: current.marker ?? unavailable(),
    };
  const data = {
    ...scope,
    bodyFormat: "node-projection-v1" as const,
    header: current.snapshot?.header ?? unavailable(),
    body: current.snapshot?.body ?? unavailable(),
  };
  if (current.marker)
    return { ...data, kind: "selected", marker: current.marker };
  return { ...data, kind: "legacy" };
}
async function captureScope(
  context: NativeVaultContext,
  scope: PhysicalCurrentCredentialScope,
  original: () => void,
  revalidate: () => Promise<void>,
): Promise<PhysicalCurrentCredentialScopeReader> {
  const held = context.capture(original, scope.tomb);
  const current = await snapshot(held.process, scope.tomb);
  const entry = scopeEntry(scope, current);
  const wire = JSON.stringify(current);
  return {
    check: held.check,
    close: held.close,
    async read() {
      held.check();
      return entry;
    },
    async revalidate(expected) {
      held.check();
      if (
        expected !== entry ||
        JSON.stringify(await snapshot(held.process, scope.tomb)) !== wire
      )
        unavailable();
      await revalidate();
    },
  };
}
async function captureCatalogue(
  context: NativeVaultContext,
  original: () => void,
) {
  const { native } = context;
  original();
  const process = native.custody().credential ?? unavailable();
  const names = await inventoryNames(process);
  const physicalIdentity = await identity(process);
  let closed = false;
  const check = () => {
    original();
    process.check();
    if (closed || native.custody().credential !== process) unavailable();
  };
  const scopes = Object.freeze(
    names.map((tomb) =>
      Object.freeze({ tomb, physicalIdentity: `${physicalIdentity}:${tomb}` }),
    ),
  );
  const issued = new Set<PhysicalCurrentCredentialScope>(scopes);
  const value = Object.freeze({ physicalIdentity, scopes });
  async function revalidate(
    expected: PhysicalCurrentCredentialCatalogueSnapshot,
  ) {
    check();
    if (expected !== value) unavailable();
    await process.request({ kind: "validate" });
    if (JSON.stringify(await inventoryNames(process)) !== JSON.stringify(names))
      unavailable();
    check();
  }
  return {
    check,
    async close() {
      closed = true;
    },
    async read() {
      await revalidate(value);
      return value;
    },
    revalidate,
    async captureScope(
      scope: PhysicalCurrentCredentialScope,
      scopeOriginal: () => void,
    ) {
      if (!issued.has(scope)) unavailable();
      await revalidate(value);
      return await captureScope(
        context,
        scope,
        () => {
          check();
          scopeOriginal();
        },
        () => revalidate(value),
      );
    },
  };
}
export function cataloguePort(
  context: NativeVaultContext,
): PhysicalCurrentCredentialCataloguePort {
  return { capture: (original) => captureCatalogue(context, original) };
}
