/** @vitest-environment jsdom */
import type { PlanIdentity } from "@opensesame/capability-composition";
import { afterEach, expect, it } from "vitest";
import {
  configureLeaseIssuerScope,
  listRetiredLeaseIdentifiers,
  resolveRetiredLeaseIdentifier,
} from "../../lib/capabilities/lease-canary-issuer.js";
import { mintLease } from "../../lib/capabilities/lease.js";
import { observeControlledIdentifier } from "../../lib/credential-canaries/observe.js";
import { currentCredentialObservationIdentity } from "../../lib/credential-canaries/owner.js";
import {
  configureCredentialCanaryIssuer,
  listControlledCanaries,
} from "../../lib/credential-canaries/registry.js";
import { vaultStore } from "../../lib/vault/store.js";
import { canaryPanel } from "../security/canary-panel.js";
import { click, field, ownerPanel } from "./panel-dom.fixture.js";

let stopScope = () => {};
afterEach(() => stopScope());
const identity: PlanIdentity = {
  instanceId: "panel-instance",
  installationId: "panel-installation",
  vaultId: "personal",
  distributionId: "panel-distribution",
  policyRevision: "r1",
  selectionRevision: "s1",
  planDigest: `sha256:${"0".repeat(64)}`,
};
it("shows only actual revoked local leases and fresh-owner enrollment records their detection context without restoring lease authority", async () => {
  const f = await ownerPanel();
  document.body.append(
    canaryPanel(f.bridge.client, (text) => f.messages.push(text)),
  );
  await vaultStore.unlock(f.owner.password);
  const vaultIdentity = currentCredentialObservationIdentity("personal");
  stopScope = configureLeaseIssuerScope(() => ({
    tomb: "personal",
    vaultIdentity,
  }));
  configureCredentialCanaryIssuer({
    resolveRetiredIdentifier: resolveRetiredLeaseIdentifier,
  });
  expect(listRetiredLeaseIdentifiers("personal")).toEqual([]);
  field("Current vault password for canaries").value = f.owner.password;
  await click("Review revoked local agent leases");
  expect(f.messages.at(-1)).toContain("No revoked local issuer identifiers");
  await vaultStore.unlock(f.owner.password);
  const issued = mintLease(identity, 37);
  expect(issued.lease.signal.aborted).toBe(false);
  issued.abort("owner-retired-lease");
  field("Current vault password for canaries").value = f.owner.password;
  await click("Review revoked local agent leases");
  expect(document.body.textContent).toContain(
    "Revoked local agent lease 1, generation 37",
  );
  field("Current vault password for canaries").value = "wrong-owner";
  await click("Monitor revoked lease 1");
  expect(f.messages.at(-1)).toContain("Owner management failed");
  expect((await listControlledCanaries("personal")).artifacts).toEqual([]);
  field("Current vault password for canaries").value = f.owner.password;
  await click("Monitor revoked lease 1");
  expect(f.messages.at(-1)).toContain("Retired lease identifier enrolled");
  const state = await listControlledCanaries("personal");
  expect(state.artifacts).toHaveLength(1);
  expect(state.artifacts[0]).toMatchObject({
    state: "retired",
    context: { vaultIdentity, kind: "agent_lease", generation: 37 },
  });
  expect(issued.lease.signal.aborted).toBe(true);
  await vaultStore.unlock(f.owner.password);
  const [record] = listRetiredLeaseIdentifiers("personal");
  const resolved = await resolveRetiredLeaseIdentifier(
    record.issuerRecordRef,
    "personal",
  );
  await observeControlledIdentifier({
    ...resolved,
    tomb: "personal",
    phase: "retired_generation_observed",
  });
  field("Current vault password for canaries").value = f.owner.password;
  await click("Refresh canary status");
  expect(document.body.textContent).toContain("Retired generation observed");
  expect(document.body.textContent).not.toContain(resolved.presentedId);
  expect(document.body.textContent).not.toContain(record.issuerRecordRef);
  // A refreshed empty inventory replaces the original selectable rows.
  stopScope();
  field("Current vault password for canaries").value = f.owner.password;
  await click("Review revoked local agent leases");
  expect(document.body.textContent).not.toContain("Monitor revoked lease 1");
});
