/** @vitest-environment jsdom */
import { Blob } from "node:buffer";
import { URL } from "node:url";
import { expect, it, vi } from "vitest";
import { observeControlledIdentifier } from "../../lib/credential-canaries/observe.js";
import {
  type CanaryArtifact,
  contextSchema,
  presentedIdSchema,
} from "../../lib/credential-canaries/protocol.js";
import { listControlledCanaries } from "../../lib/credential-canaries/registry.js";
import { canaryRegistryKey } from "../../lib/credential-canaries/storage.js";
import { kvGet } from "../../lib/kv.js";
import { enrollRetiredCredential } from "../../lib/retired-credentials/index.js";
import { vaultStore } from "../../lib/vault/store.js";
import { canaryPanel } from "../security/canary-panel.js";
import {
  button,
  click,
  field,
  onPanelCleanup,
  ownerPanel,
} from "./panel-dom.fixture.js";

function downloadCapture() {
  vi.stubGlobal("URL", URL);
  vi.stubGlobal("Blob", Blob);
  const values: Blob[] = [];
  const originalTimeout = globalThis.setTimeout;
  const timers: ReturnType<typeof setTimeout>[] = [];
  vi.spyOn(globalThis, "setTimeout").mockImplementation(
    (callback, delay, ...args) => {
      const timer = originalTimeout(callback, delay, ...args);
      if (delay === 60_000) timers.push(timer);
      return timer;
    },
  );
  onPanelCleanup(() => {
    for (const timer of timers) clearTimeout(timer);
  });
  const urls = vi.spyOn(URL, "createObjectURL").mockImplementation((blob) => {
    values.push(blob);
    return `blob:public-test-${values.length}`;
  });
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
  return { values, urls };
}
function artifactFrom(raw: string): CanaryArtifact {
  const value = JSON.parse(raw).artifact;
  return {
    id: value.id,
    context: contextSchema.parse(value.context),
    presentedId: presentedIdSchema.parse(value.presentedId),
  };
}

it("exports actual controlled artifacts once, renders closed evidence and revokes without revealing identifiers", async () => {
  const f = await ownerPanel();
  const capture = downloadCapture();
  document.body.append(
    canaryPanel(f.bridge.client, (text) => f.messages.push(text)),
  );
  const password = field("Current vault password for canaries");
  const kind = document.querySelector("select");
  if (!kind) throw new Error("Missing actual kind selector");
  expect(Array.from(kind.options).map((option) => option.value)).toEqual([
    "connection_ref",
    "mcp_configuration",
    "token_generation",
    "agent_lease",
  ]);
  password.value = f.owner.password;
  await click("Create and export canary");
  expect(capture.values).toHaveLength(1);
  const artifact = artifactFrom(await capture.values[0].text());
  expect(artifact.context.kind).toBe("connection_ref");
  expect(password.value).toBe("");
  expect(document.body.textContent).not.toContain(artifact.presentedId);
  expect(kvGet(canaryRegistryKey("personal"))).not.toContain(
    artifact.presentedId,
  );
  for (const phase of ["connected", "invoked", "artifact_dispatched"] as const)
    await observeControlledIdentifier({ tomb: "personal", ...artifact, phase });
  password.value = f.owner.password;
  await click("Refresh canary status");
  expect(document.body.textContent).toContain(
    "connection_ref 1 · generation 1 · bait",
  );
  for (const label of [
    "Validator connected",
    "Synthetic tool invoked",
    "Artifact exported",
  ])
    expect(document.body.textContent).toContain(label);
  password.value = f.owner.password;
  await click("Clear canary observations");
  expect((await listControlledCanaries("personal")).events).toEqual([]);
  expect(document.body.textContent).not.toContain("Validator connected");
  password.value = f.owner.password;
  await click("Revoke canary");
  expect((await listControlledCanaries("personal")).artifacts).toEqual([]);
  expect(password.value).toBe("");
  expect(f.messages.at(0)).toContain("Exported once");
});

it("exports a valid operational MCP configuration and refuses invalid selectors or wrong owner proof", async () => {
  const f = await ownerPanel();
  const capture = downloadCapture();
  document.body.append(
    canaryPanel(f.bridge.client, (text) => f.messages.push(text)),
  );
  const kind = document.querySelector("select");
  if (!kind) throw new Error("Missing actual kind selector");
  kind.value = "mcp_configuration";
  field("Current vault password for canaries").value = f.owner.password;
  await click("Create and export canary");
  const config = JSON.parse(await capture.values[0].text());
  expect(config.mcpServers.OpenSesameCanary).toEqual({
    command: "opensesame-id",
    args: ["canary", "serve", "--config", "opensesame-canary.json"],
  });
  expect(config.validatorBinding.context).toEqual(config.artifact.context);
  expect(config.validatorBinding.artifactId).toBe(config.artifact.id);
  const before = f.bridge.transport.sent.length;
  kind.value = "unknown";
  field("Current vault password for canaries").value = f.owner.password;
  await click("Create and export canary");
  expect(f.messages.at(-1)).toBe("Invalid canary type.");
  expect(f.bridge.transport.sent).toHaveLength(before);
  kind.value = "token_generation";
  field("Current vault password for canaries").value = "wrong-owner-password";
  await click("Create and export canary");
  expect(f.messages.at(-1)).toContain("Owner management failed");
  expect(capture.values).toHaveLength(1);
  expect((await listControlledCanaries("personal")).artifacts).toHaveLength(1);
  expect(field("Current vault password for canaries").value).toBe("");
});

it("withholds an already accepted export after real reauthentication and recovers only through a fresh action", async () => {
  const f = await ownerPanel();
  const capture = downloadCapture();
  document.body.append(
    canaryPanel(f.bridge.client, (text) => f.messages.push(text)),
  );
  const accepted = f.bridge.transport.hold();
  field("Current vault password for canaries").value = f.owner.password;
  const action = click("Create and export canary");
  try {
    await accepted;
    expect(f.bridge.transport.waiting).toHaveLength(1);
    f.bridge.transport.release();
    const reauthenticated = f.bridge.client.unlock(f.owner.password);
    await reauthenticated;
    await action;
  } finally {
    f.bridge.transport.release();
    await action;
    await f.bridge.drain();
  }
  expect(button("Create and export canary").disabled).toBe(false);
  expect(capture.values).toEqual([]);
  expect(f.messages.at(-1)).toContain("Owner management failed");
  field("Current vault password for canaries").value = f.owner.password;
  await click("Create and export canary");
  expect(capture.values).toHaveLength(1);
});

it("a real selected retired password cannot manage canaries, and owner recovery retains the original records", async () => {
  const f = await ownerPanel();
  await vaultStore.unlock(f.owner.password);
  await enrollRetiredCredential({
    tomb: "personal",
    currentPassword: f.owner.password,
    retiredPassword: "selected-retired-panel-password",
    response: "synthetic_decoy",
    acknowledgePasswordVerifierRisk: true,
  });
  vaultStore.lock();
  await expect(
    f.bridge.client.unlock("selected-retired-panel-password"),
  ).resolves.toMatchObject({ realm: "synthetic" });
  const capture = downloadCapture();
  document.body.append(
    canaryPanel(f.bridge.client, (text) => f.messages.push(text)),
  );
  field("Current vault password for canaries").value = f.owner.password;
  await click("Create and export canary");
  expect(capture.values).toEqual([]);
  expect(f.messages.at(-1)).toContain("Owner management failed");
  await f.bridge.client.unlock(f.owner.password);
  field("Current vault password for canaries").value = f.owner.password;
  await click("Create and export canary");
  expect(capture.values).toHaveLength(1);
});
