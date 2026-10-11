/**
 * What a panel test needs: the tutorial targets a panel mounts declared, and
 * a desk built on the desk tests' in-memory devices (`vi.mock` is not allowed
 * here, so a test hands panels its desk through `deskSeams`).
 */

import { registerContributionForTest } from "@opensesame/app-core/lib/contributions.js";
import type { Device } from "@opensesame/app-core/lib/quorum/desk/harness.test-support.js";
import type { OwnedRecord } from "@opensesame/app-core/lib/quorum/desk/ports.js";
import type { HeldRecord } from "@opensesame/app-core/lib/quorum/records.js";
import { TRUSTED_CONTACTS_TARGETS } from "@opensesame/app-core/tutorial/registry/trusted-contacts-catalog.js";
import { type Desk, deskSeams } from "./use-desk.js";

/** Declare the panels' tutorial targets, as the module does on activation. */
export function declareTargets(): () => void {
  const revokes = TRUSTED_CONTACTS_TARGETS.map((target) =>
    registerContributionForTest("tutorial-target", target),
  );
  return () => {
    for (const revoke of revokes) revoke();
  };
}

/** A desk over one device's ports, with the records read as they stand. */
export async function deskOf(device: Device): Promise<Desk> {
  const owned: readonly OwnedRecord[] = await device.records.owned();
  const held: readonly HeldRecord[] = await device.records.held();
  return { ports: device, owned, held, refresh: async () => undefined };
}

/** Make `useDesk()` answer with `desk` until `restore` runs. */
export function serveDesk(desk: Desk | null): () => void {
  const was = deskSeams.useDesk;
  deskSeams.useDesk = () => desk;
  return () => {
    deskSeams.useDesk = was;
  };
}

/** The element with `id`, or a failure naming it: no cast stands in for a lookup. */
export function elementById(id: string): HTMLElement {
  const found = document.getElementById(id);
  if (!found) throw new Error(`no element #${id}`);
  return found;
}

/** What a field holds, read through the DOM type the lookup proved. */
export function fieldValue(field: Element): string {
  if (field instanceof HTMLTextAreaElement || field instanceof HTMLInputElement)
    return field.value;
  throw new Error("not a field");
}

/** Whether a key is switched off. */
export function isDisabled(key: Element): boolean {
  return key.hasAttribute("disabled");
}
