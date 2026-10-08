import { observeControlledIdentifier } from "@opensesame/app-core/lib/credential-canaries/observe.js";
/** @vitest-environment jsdom */
import { createControlledCanary } from "@opensesame/app-core/lib/credential-canaries/registry.js";
import { listControlledCanaries } from "@opensesame/app-core/lib/credential-canaries/registry.js";
import { installObservationPlan } from "@opensesame/app-core/lib/credential-observation/plan-test-support.js";
import { provisionSchema } from "@opensesame/app-core/lib/credential-observation/protocol.js";
import { getObservationReceiverStatus } from "@opensesame/app-core/lib/credential-observation/receiver.js";
import {
  ObservationReferenceReceiver,
  type ObservationReferenceState,
} from "@opensesame/app-core/lib/credential-observation/reference.js";
import { receiverKey } from "@opensesame/app-core/lib/credential-observation/storage.js";
import { publicVectorProvision } from "@opensesame/app-core/lib/credential-observation/vector-test-support.js";
import { kvGet } from "@opensesame/app-core/lib/kv.js";
import { bytesToB64 } from "@opensesame/vault-core";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import ReceiverCeremony, { receiverUiPorts } from "./ReceiverCeremony.js";
import {
  RETIREMENTS,
  button,
  ceremonyOwner,
  gate,
  inputPassword,
  pairingFile,
  perform,
  releaseGate,
  restoreCeremonyOwner,
  selectPairing,
} from "./controlled-ceremony.test-support.js";

const original = { ...receiverUiPorts };
const releases: Array<() => void> = [];
afterEach(async () => {
  for (const release of releases.splice(0)) release();
  cleanup();
  Object.assign(receiverUiPorts, original);
  await restoreCeremonyOwner();
});

function provision() {
  return provisionSchema.parse({
    ...publicVectorProvision(),
    receiverId: crypto.randomUUID(),
    bindingId: crypto.randomUUID(),
    independentKeyMaterialB64: bytesToB64(
      crypto.getRandomValues(new Uint8Array(64)),
    ),
    expiresAt: new Date(Date.now() + 86400000).toISOString(),
  });
}

async function reviewed(password: string, paired = provision()) {
  inputPassword(password);
  selectPairing(pairingFile(JSON.stringify(paired)));
  await waitFor(() => expect(screen.getByText(paired.origin)).toBeTruthy());
  await waitFor(() =>
    expect(button("Confirm receiver destination").disabled).toBe(false),
  );
  return paired;
}

function receiverTransport(
  paired: ReturnType<typeof provision>,
  authenticated = true,
) {
  installObservationPlan();
  let state: ObservationReferenceState | null = null;
  const receiver = new ObservationReferenceReceiver(paired, {
    async read() {
      return state === null ? null : structuredClone(state);
    },
    async write(next) {
      state = structuredClone(next);
    },
  });
  const fetch = vi.fn<typeof globalThis.fetch>(async (destination, options) => {
    expect(destination).toBe(`${paired.origin}/v1/credential-observations`);
    expect(options).toMatchObject({
      method: "POST",
      credentials: "omit",
      redirect: "error",
      referrerPolicy: "no-referrer",
      headers: { "content-type": "application/json" },
    });
    expect(typeof options?.body).toBe("string");
    const raw = String(options?.body);
    expect(raw).not.toContain(paired.independentKeyMaterialB64);
    const ack = await receiver.receive(raw);
    return new Response(JSON.stringify(authenticated ? ack : {}), {
      status: 200,
    });
  });
  vi.stubGlobal("fetch", fetch);
  return { fetch, state: () => state };
}

it("configures disabled, verifies a real sealed ACK, toggles delivery and removes without deleting local evidence", async () => {
  const owner = await ceremonyOwner();
  const artifact = await createControlledCanary({
    tomb: "personal",
    currentPassword: owner.password,
    kind: "connection_ref",
  });
  await observeControlledIdentifier({
    tomb: "personal",
    ...artifact,
    phase: "connected",
  });
  const evidence = await listControlledCanaries("personal");
  const paired = provision();
  const transport = receiverTransport(paired);
  render(<ReceiverCeremony tomb="personal" supported />);
  await reviewed(owner.password, paired);
  await perform("Confirm receiver destination", owner.password);
  expect(await getObservationReceiverStatus("personal")).toMatchObject({
    configured: true,
    enabled: false,
    verified: false,
    durable: true,
  });
  inputPassword(owner.password);
  expect(button("Enable observation receiver").disabled).toBe(true);
  await perform("Test observation receiver", owner.password);
  expect(
    screen.getByText("Receiver acknowledged sealed delivery."),
  ).toBeTruthy();
  expect(await getObservationReceiverStatus("personal")).toMatchObject({
    enabled: false,
    verified: true,
  });
  expect(transport.fetch).toHaveBeenCalledTimes(1);
  expect(transport.state()?.receipts[0].metadata.event).toEqual({
    type: "receiver_test",
  });
  expect(String(transport.fetch.mock.calls[0][1]?.body)).not.toContain(
    owner.password,
  );
  expect(document.body.textContent).not.toContain(
    paired.independentKeyMaterialB64,
  );
  await perform("Enable observation receiver", owner.password);
  expect(await getObservationReceiverStatus("personal")).toMatchObject({
    enabled: true,
    verified: true,
  });
  await perform("Disable observation receiver", owner.password);
  expect(await getObservationReceiverStatus("personal")).toMatchObject({
    enabled: false,
    verified: true,
  });
  await perform("Remove observation receiver", owner.password);
  expect(await getObservationReceiverStatus("personal")).toMatchObject({
    configured: false,
    enabled: false,
    verified: false,
  });
  expect(await listControlledCanaries("personal")).toEqual(evidence);
});

it("does not enable delivery after an HTTP success lacking an authenticated ACK", async () => {
  const owner = await ceremonyOwner();
  const paired = provision();
  const transport = receiverTransport(paired, false);
  render(<ReceiverCeremony tomb="personal" supported />);
  await reviewed(owner.password, paired);
  await perform("Confirm receiver destination", owner.password);
  await perform("Test observation receiver", owner.password);
  expect(
    screen.getByText("No authenticated delivery acknowledgement."),
  ).toBeTruthy();
  expect(await getObservationReceiverStatus("personal")).toMatchObject({
    enabled: false,
    verified: false,
    failed: 1,
  });
  inputPassword(owner.password);
  expect(button("Enable observation receiver").disabled).toBe(true);
  expect(transport.fetch).toHaveBeenCalledTimes(1);
});

it("invalid, oversized or removed pairing input clears the previously reviewed destination without mutation", async () => {
  const owner = await ceremonyOwner();
  render(<ReceiverCeremony tomb="personal" supported />);
  await reviewed(owner.password);
  selectPairing();
  expect(screen.getByText("None")).toBeTruthy();
  expect(button("Confirm receiver destination").disabled).toBe(true);
  for (const raw of [
    "not-json",
    " ".repeat(8193),
    JSON.stringify({
      ...provision(),
      origin: "https://receiver.example/secret",
    }),
  ]) {
    await reviewed(owner.password);
    const invalid = pairingFile(raw);
    const read = vi.spyOn(invalid, "text");
    selectPairing(invalid);
    await waitFor(() =>
      expect(
        screen.getByText(
          "The pairing file is invalid or the owner session changed.",
        ),
      ).toBeTruthy(),
    );
    expect(screen.getByText("None")).toBeTruthy();
    expect(button("Confirm receiver destination").disabled).toBe(true);
    if (invalid.size > 8192) expect(read).not.toHaveBeenCalled();
    else expect(read).toHaveBeenCalledTimes(1);
    expect(kvGet(receiverKey("personal"))).toBeNull();
  }
});

it.each(RETIREMENTS)(
  "rejects a real held File.text after %s and accepts only a newly selected file",
  async (retirement) => {
    const owner = await ceremonyOwner(retirement === "synthetic");
    render(<ReceiverCeremony tomb="personal" supported />);
    // Settle the independent initial status read before isolating File.text.
    await reviewed(owner.password);
    const paired = provision();
    const file = pairingFile(JSON.stringify(paired));
    const started = gate();
    const held = gate();
    releases.push(held.release);
    const text = file.text.bind(file);
    vi.spyOn(file, "text").mockImplementation(async () => {
      started.release();
      await held.promise;
      return text();
    });
    inputPassword(owner.password);
    const before = kvGet(receiverKey("personal"));
    selectPairing(file);
    await started.promise;
    await act(async () => owner.retire(retirement));
    await releaseGate(held);
    await waitFor(() =>
      expect(
        screen.getByText(
          "The pairing file is invalid or the owner session changed.",
        ),
      ).toBeTruthy(),
    );
    expect(screen.queryByText(paired.origin)).toBeNull();
    expect(button("Confirm receiver destination").disabled).toBe(true);
    expect(kvGet(receiverKey("personal"))).toBe(before);
    await act(async () => owner.recover());
    expect(await getObservationReceiverStatus("personal")).toMatchObject({
      configured: false,
    });
    await reviewed(owner.password, paired);
    await perform("Confirm receiver destination", owner.password);
    expect(await getObservationReceiverStatus("personal")).toMatchObject({
      configured: true,
      enabled: false,
      verified: false,
    });
  },
);
