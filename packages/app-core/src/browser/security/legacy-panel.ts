import { z } from "zod";
import type { securityClient } from "./client.js";
import { action, element, secret } from "./dom.js";
const statusSchema = z
  .object({
    pending: z.boolean(),
    available: z.boolean(),
    records: z
      .array(
        z
          .object({
            connectionId: z.string().min(1).max(256),
            providerId: z.string().max(256),
            displayName: z.string().max(1024),
          })
          .strict(),
      )
      .max(256),
  })
  .strict();
type Client = ReturnType<typeof securityClient>;
export function legacyConnectorPanel(
  client: Client,
  say: (words: string) => void,
) {
  const root = element("section");
  const current = secret("Current vault password for legacy records");
  const list = element("div");
  const selected = new Set<string>();
  const acknowledgment = element("input");
  acknowledgment.type = "checkbox";
  const acknowledged = element(
    "label",
    "I understand original ownership cannot be proven and confirm the selected import or permanent discard.",
  );
  acknowledged.append(acknowledgment);
  const decision = element("select");
  decision.setAttribute("aria-label", "Selected legacy record action");
  for (const [value, label] of [
    ["import", "Import into this vault"],
    ["discard", "Discard selected records"],
  ] as const) {
    const option = element("option", label);
    option.value = value;
    decision.append(option);
  }
  async function perform(resolve: boolean) {
    try {
      const permit = client.permit();
      if (
        resolve &&
        (!acknowledgment.checked || !selected.size || selected.size > 16)
      )
        throw new Error(
          "Select up to 16 records and acknowledge their uncertain ownership.",
        );
      const raw = await client.manage(
        resolve
          ? {
              verb: "legacy-resolve",
              connectionIds: [...selected],
              decision: decision.value === "discard" ? "discard" : "import",
              acknowledgeOwnershipAmbiguity: true,
            }
          : { verb: "legacy-status" },
        current.input.value,
      );
      if (!(await client.authorize()) || client.permit() !== permit)
        throw new Error("The owner session changed. Authenticate again.");
      const status = statusSchema.parse(JSON.parse(raw));
      corruptAcknowledgment.hidden = !status.pending || status.available;
      discardCorrupt.hidden = !status.pending || status.available;
      selected.clear();
      acknowledgment.checked = false;
      list.replaceChildren();
      appendRecordChoices(list, selected, status.records);
      say(
        !status.pending
          ? "No legacy connector records remain."
          : status.available
            ? "Review up to 16 legacy records at a time; repeat until none remain."
            : "Legacy data is unreadable. Restore trusted device data before retrying.",
      );
    } finally {
      current.input.value = "";
    }
  }
  const { corruptAcknowledgment, discardCorrupt } = irrecoverableControls(
    client,
    current,
    say,
  );
  root.append(
    element("h3", "Legacy connector records"),
    element(
      "p",
      "Old records were device-key protected; their original vault ownership cannot be proven. Import seals selected records under this current vault's root. Discard permanently removes only selected records. Fresh one-password owner proof is required.",
    ),
    current.wrapper,
    action("Review legacy connector records", () => perform(false), say),
    list,
    decision,
    acknowledged,
    action("Resolve selected legacy records", () => perform(true), say),
    corruptAcknowledgment,
    discardCorrupt,
  );
  return root;
}

function irrecoverableControls(
  client: Client,
  current: ReturnType<typeof secret>,
  say: (words: string) => void,
) {
  const corrupt = element("input");
  corrupt.type = "checkbox";
  const corruptAcknowledgment = element(
    "label",
    "I explicitly confirm permanent loss of all unreadable legacy secret records; current vault-owned records remain.",
  );
  corruptAcknowledgment.append(corrupt);
  corruptAcknowledgment.hidden = true;
  const discardCorrupt = action(
    "Discard unreadable legacy secret records",
    async () => {
      try {
        if (!corrupt.checked)
          throw new Error("Confirm permanent legacy-record loss first.");
        await client.manage(
          {
            verb: "legacy-discard-corrupt",
            acknowledgeIrrecoverableLegacyDiscard: true,
          },
          current.input.value,
        );
        say("Unreadable legacy secret records discarded. Review status again.");
      } finally {
        current.input.value = "";
        corrupt.checked = false;
      }
    },
    say,
  );
  discardCorrupt.hidden = true;
  return { corruptAcknowledgment, discardCorrupt };
}

function appendRecordChoices(
  list: HTMLDivElement,
  selected: Set<string>,
  records: z.infer<typeof statusSchema>["records"],
) {
  for (const record of records) {
    const checkbox = element("input");
    checkbox.type = "checkbox";
    const label = element(
      "label",
      `${record.displayName} · ${record.providerId} · ${record.connectionId}`,
    );
    checkbox.addEventListener("change", () =>
      checkbox.checked
        ? selected.add(record.connectionId)
        : selected.delete(record.connectionId),
    );
    label.append(checkbox);
    list.append(label);
  }
}
