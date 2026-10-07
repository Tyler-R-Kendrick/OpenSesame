/** @vitest-environment jsdom */
import { File } from "node:buffer";
import { afterEach, expect, it, vi } from "vitest";
import { installObservationPlan } from "../../lib/credential-observation/plan-test-support.js";
import { getObservationReceiverStatus } from "../../lib/credential-observation/receiver.js";
import {
  ObservationReferenceReceiver,
  type ObservationReferenceState,
} from "../../lib/credential-observation/reference.js";
import { publicVectorProvision } from "../../lib/credential-observation/vector-test-support.js";
import { receiverPanel } from "../security/receiver-panel.js";
import { click, field, ownerPanel, selectFile } from "./panel-dom.fixture.js";

let restorePlan = () => {};
afterEach(() => restorePlan());
function pairing() {
  return {
    ...publicVectorProvision(),
    origin: "https://receiver.example",
    allowLoopback: false,
    expiresAt: new Date(Date.now() + 86400000).toISOString(),
  };
}
async function choose(provision = pairing()) {
  selectFile(
    new File([JSON.stringify(provision)], "public-receiver-fixture.json"),
  );
  await vi.waitFor(() =>
    expect(document.body.textContent).toContain(
      `Confirm destination: ${provision.origin}`,
    ),
  );
  return provision;
}
async function perform(label: string, password: string) {
  field("Current vault password for receiver").value = password;
  await click(label);
  expect(field("Current vault password for receiver").value).toBe("");
}
function receiverTransport(provision: ReturnType<typeof pairing>) {
  restorePlan = installObservationPlan().restore;
  let state: ObservationReferenceState | null = null;
  const receiver = new ObservationReferenceReceiver(provision, {
    read: async () => state,
    write: async (value) => {
      state = structuredClone(value);
    },
  });
  let badAck = false;
  const requests: Array<{ destination: string; init: RequestInit }> = [];
  vi.stubGlobal("fetch", async (destination: string, init: RequestInit) => {
    requests.push({ destination, init });
    const ack = await receiver.receive(String(init.body));
    return new Response(
      JSON.stringify(badAck ? { ...ack, macB64: "A".repeat(44) } : ack),
    );
  });
  return {
    requests,
    invalidAcknowledgement: () => {
      badAck = true;
    },
    genuineAcknowledgement: () => {
      badAck = false;
    },
  };
}

it("keeps receiver local-only by default and requires reviewed pairing, real owner proof and genuine ACK before enabling", async () => {
  const f = await ownerPanel();
  document.body.append(
    receiverPanel(f.bridge.client, (text) => f.messages.push(text)),
  );
  expect(document.body.textContent).toContain(
    "Local evidence only. No receiver provisioned.",
  );
  await click("Toggle receiver delivery");
  expect(f.messages.at(-1)).toBe("Configure and verify the receiver first.");
  await click("Confirm receiver destination");
  expect(f.messages.at(-1)).toBe("Choose and review a pairing file.");
  await perform("Refresh receiver status", f.owner.password);
  expect(document.body.textContent).toContain(
    "Local evidence only. No receiver configured.",
  );
  const provision = await choose();
  const transport = receiverTransport(provision);
  expect(document.body.textContent).not.toContain(
    provision.independentKeyMaterialB64,
  );
  await perform("Confirm receiver destination", "wrong-owner-proof");
  expect(f.messages.at(-1)).toContain("Owner management failed");
  expect((await getObservationReceiverStatus("personal")).configured).toBe(
    false,
  );
  await perform("Confirm receiver destination", f.owner.password);
  expect(document.body.textContent).toContain(
    "disabled · not tested · 0 queued",
  );
  await click("Toggle receiver delivery");
  expect(f.messages.at(-1)).toBe("Configure and verify the receiver first.");
  await perform("Test observation receiver", f.owner.password);
  expect(f.messages.at(-1)).toContain("Receiver acknowledged sealed delivery");
  expect(transport.requests).toHaveLength(1);
  expect(transport.requests[0].destination).toBe(
    `${provision.origin}/v1/credential-observations`,
  );
  expect(transport.requests[0].init).toMatchObject({
    method: "POST",
    credentials: "omit",
    redirect: "error",
    referrerPolicy: "no-referrer",
    headers: { "content-type": "application/json" },
  });
  expect(String(transport.requests[0].init.body)).not.toContain(
    f.owner.password,
  );
  expect(String(transport.requests[0].init.body)).not.toContain(
    "receiver_test",
  );
  // Testing does not implicitly update the displayed status or enable delivery.
  await click("Toggle receiver delivery");
  expect(f.messages.at(-1)).toBe("Configure and verify the receiver first.");
  await perform("Refresh receiver status", f.owner.password);
  expect(document.body.textContent).toContain("disabled · verified · 0 queued");
  await perform("Toggle receiver delivery", f.owner.password);
  expect((await getObservationReceiverStatus("personal")).enabled).toBe(true);
  expect(document.body.textContent).toContain("enabled · verified");
  await perform("Toggle receiver delivery", f.owner.password);
  expect((await getObservationReceiverStatus("personal")).enabled).toBe(false);
  await choose({ ...provision, bindingId: "successor-binding" });
  await perform("Confirm receiver destination", f.owner.password);
  expect(await getObservationReceiverStatus("personal")).toMatchObject({
    configured: true,
    enabled: false,
    verified: false,
  });
  await perform("Remove observation receiver", f.owner.password);
  expect(document.body.textContent).toContain(
    "Local evidence only. No receiver configured.",
  );
  expect((await getObservationReceiverStatus("personal")).configured).toBe(
    false,
  );
  await click("Confirm receiver destination");
  expect(f.messages.at(-1)).toBe("Choose and review a pairing file.");
});

it("a forged receiver response never becomes verified and retry or reconfiguration cannot rearm its observation budget", async () => {
  const f = await ownerPanel();
  document.body.append(
    receiverPanel(f.bridge.client, (text) => f.messages.push(text)),
  );
  const provision = await choose();
  const transport = receiverTransport(provision);
  await perform("Confirm receiver destination", f.owner.password);
  transport.invalidAcknowledgement();
  await perform("Test observation receiver", f.owner.password);
  expect(f.messages.at(-1)).toBe(
    "No authenticated acknowledgement; queued is not delivered.",
  );
  expect((await getObservationReceiverStatus("personal")).verified).toBe(false);
  transport.genuineAcknowledgement();
  await perform("Test observation receiver", f.owner.password);
  expect(f.messages.at(-1)).toBe(
    "No authenticated acknowledgement; queued is not delivered.",
  );
  expect(transport.requests).toHaveLength(1);
  expect((await getObservationReceiverStatus("personal")).verified).toBe(false);
  await perform("Refresh receiver status", f.owner.password);
  await click("Toggle receiver delivery");
  expect(f.messages.at(-1)).toBe("Configure and verify the receiver first.");
  await choose({ ...provision, bindingId: "successor-binding" });
  await perform("Confirm receiver destination", f.owner.password);
  expect(await getObservationReceiverStatus("personal")).toMatchObject({
    configured: true,
    enabled: false,
    verified: false,
  });
  expect(document.body.textContent).toContain("disabled · not tested");
});
