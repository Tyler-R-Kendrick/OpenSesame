import { z } from "zod";
import type { securityClient } from "./client.js";
import { action, element, secret } from "./dom.js";
const statusSchema = z
  .object({
    configured: z.boolean(),
    receiverId: z.string().optional(),
    origin: z.string().optional(),
    enabled: z.boolean(),
    verified: z.boolean(),
    expiresAt: z.string().optional(),
    queued: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    durable: z.boolean(),
  })
  .strict();
type Client = ReturnType<typeof securityClient>;
type View = {
  client: Client;
  say: (words: string) => void;
  current: ReturnType<typeof secret>;
  pairingJson: string;
  destination: HTMLParagraphElement;
  status: HTMLParagraphElement;
  state: z.infer<typeof statusSchema> | null;
};
async function importPairing(
  view: View,
  file: File | undefined,
): Promise<void> {
  view.pairingJson = "";
  view.destination.textContent = "No pairing selected.";
  if (!file) return;
  if (file.size > 8192) throw new Error("Pairing exceeds its size limit.");
  const permit = view.client.permit();
  const api = await import("../../lib/credential-observation/index.js");
  const raw = await file.text();
  const provision = api.parseObservationReceiverProvision(raw);
  if (!(await view.client.authorize()) || view.client.permit() !== permit)
    throw new Error("Authenticate the real owner again.");
  view.pairingJson = raw;
  view.destination.textContent = `Confirm destination: ${provision.origin}`;
}
async function perform(
  view: View,
  operation: Parameters<Client["manage"]>[0],
): Promise<void> {
  try {
    const raw = await view.client.manage(operation, view.current.input.value);
    if (operation.verb === "receiver-test") {
      const result = z
        .object({ delivered: z.boolean() })
        .strict()
        .parse(JSON.parse(raw));
      view.say(
        result.delivered
          ? "Receiver acknowledged sealed delivery. Refresh status before enabling."
          : "No authenticated acknowledgement; queued is not delivered.",
      );
      return;
    }
    const state = statusSchema.parse(JSON.parse(raw));
    view.state = state;
    view.status.textContent = state.configured
      ? `${state.origin} · ${state.enabled ? "enabled" : "disabled"} · ${state.verified ? "verified" : "not tested"} · ${state.queued} queued`
      : "Local evidence only. No receiver configured.";
  } finally {
    view.current.input.value = "";
  }
}
export function receiverPanel(client: Client, say: (words: string) => void) {
  const root = element("section");
  const view: View = {
    client,
    say,
    current: secret("Current vault password for receiver"),
    pairingJson: "",
    destination: element("p", "No pairing selected."),
    status: element("p", "Local evidence only. No receiver provisioned."),
    state: null,
  };
  const pairing = element("input");
  pairing.type = "file";
  pairing.accept = "application/json";
  pairing.setAttribute("aria-label", "Receiver pairing file");
  pairing.addEventListener("change", () => {
    const file = pairing.files?.[0];
    pairing.value = "";
    void importPairing(view, file).catch(() =>
      say("Pairing invalid or owner session closed."),
    );
  });
  root.append(
    element("h3", "Observation receiver"),
    element(
      "p",
      "Optional supplied receiver. Sealed metadata uses its fixed route without cookies or redirects. Pairing keys use device at-rest protection. Fresh one-password owner management is required.",
    ),
    view.current.wrapper,
    pairing,
    view.destination,
    view.status,
    action(
      "Refresh receiver status",
      () => perform(view, { verb: "receiver-status" }),
      say,
    ),
    action(
      "Confirm receiver destination",
      async () => {
        if (!view.pairingJson)
          throw new Error("Choose and review a pairing file.");
        await perform(view, {
          verb: "receiver-configure",
          pairingJson: view.pairingJson,
        });
        view.pairingJson = "";
      },
      say,
    ),
    action(
      "Test observation receiver",
      () => perform(view, { verb: "receiver-test" }),
      say,
    ),
    action(
      "Toggle receiver delivery",
      async () => {
        if (
          !view.state?.configured ||
          (!view.state.enabled && !view.state.verified)
        )
          throw new Error("Configure and verify the receiver first.");
        await perform(view, {
          verb: "receiver-enabled",
          enabled: !view.state.enabled,
        });
      },
      say,
    ),
    action(
      "Remove observation receiver",
      () => perform(view, { verb: "receiver-remove" }),
      say,
    ),
  );
  return root;
}
