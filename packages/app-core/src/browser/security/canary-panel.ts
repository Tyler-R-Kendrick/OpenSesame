import { z } from "zod";
import {
  contextSchema,
  presentedIdSchema,
} from "../../lib/credential-canaries/protocol.js";
import {
  artifactRecordSchema,
  eventSchema,
} from "../../lib/credential-canaries/records.js";
import { validatorBindingSchema } from "../../lib/credential-canaries/validator-binding.js";
import type { securityClient } from "./client.js";
import { action, element, secret } from "./dom.js";
import { issuedPanel } from "./issued-panel.js";
const statusSchema = z
  .object({
    vaultIdentity: z.string(),
    artifacts: z.array(artifactRecordSchema.omit({ digestB64: true })).max(16),
    events: z.array(eventSchema).max(64),
    durable: z.boolean(),
  })
  .strict();
const artifactSchema = z
  .object({
    id: z.string().uuid(),
    context: contextSchema,
    presentedId: presentedIdSchema,
  })
  .strict();
const createdSchema = z
  .object({
    artifact: artifactSchema,
    configuration: z
      .object({
        v: z.literal(1),
        tomb: z.string(),
        artifact: artifactSchema,
        validatorBinding: validatorBindingSchema,
        mcpServers: z
          .object({
            OpenSesameCanary: z
              .object({
                command: z.literal("opensesame-id"),
                args: z.array(z.string()).max(8),
              })
              .strict(),
          })
          .strict(),
      })
      .strict()
      .optional(),
  })
  .strict();
function download(value: string) {
  const url = URL.createObjectURL(
    new Blob([value], { type: "application/json" }),
  );
  const link = element("a");
  link.href = url;
  link.download = "opensesame-canary.json";
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
type View = {
  client: ReturnType<typeof securityClient>;
  say: (words: string) => void;
  current: ReturnType<typeof secret>;
  kind: HTMLSelectElement;
  rows: HTMLUListElement;
  events: HTMLUListElement;
};
function show(view: View, raw: string): void {
  const status = statusSchema.parse(JSON.parse(raw));
  view.rows.replaceChildren(
    ...status.artifacts.map((artifact, index) => {
      const row = element(
        "li",
        `${artifact.context.kind} ${index + 1} · generation ${artifact.context.generation} · ${artifact.state}`,
      );
      row.append(
        action(
          "Revoke canary",
          async () => {
            try {
              show(
                view,
                await view.client.manage(
                  { verb: "canary-remove", artifactId: artifact.id },
                  view.current.input.value,
                ),
              );
            } finally {
              view.current.input.value = "";
            }
          },
          view.say,
        ),
      );
      return row;
    }),
  );
  const labels = {
    connected: "Validator connected",
    invoked: "Synthetic tool invoked",
    retired_generation_observed: "Retired generation observed",
    artifact_dispatched: "Artifact exported",
  };
  view.events.replaceChildren(
    ...status.events.map((event) =>
      element("li", `${event.at} · ${labels[event.phase]}`),
    ),
  );
}
async function create(view: View): Promise<void> {
  try {
    const selected = view.kind.value;
    if (
      selected !== "connection_ref" &&
      selected !== "mcp_configuration" &&
      selected !== "token_generation" &&
      selected !== "agent_lease"
    )
      throw new Error("Invalid canary type.");
    const created = createdSchema.parse(
      JSON.parse(
        await view.client.manage(
          { verb: "canary-create", kind: selected },
          view.current.input.value,
        ),
      ),
    );
    if (created.configuration)
      created.configuration.mcpServers.OpenSesameCanary.args = [
        "canary",
        "serve",
        "--config",
        "opensesame-canary.json",
      ];
    download(
      JSON.stringify(
        created.configuration ?? { v: 1, artifact: created.artifact },
        null,
        2,
      ),
    );
    view.say(
      "Exported once. Prepare an owner-only file (chmod 600 FILE on Unix). Install with opensesame-id canary install --config FILE --trust-configuration; detector evidence stays in that CLI environment.",
    );
  } finally {
    view.current.input.value = "";
  }
}
/** Only a background-bound owner may manage or receive a one-time artifact. */
export function canaryPanel(
  client: ReturnType<typeof securityClient>,
  say: (words: string) => void,
) {
  const root = element("section");
  const view: View = {
    client,
    say,
    current: secret("Current vault password for canaries"),
    kind: element("select"),
    rows: element("ul"),
    events: element("ul"),
  };
  view.kind.setAttribute("aria-label", "Controlled canary type");
  for (const [value, label] of Object.entries({
    connection_ref: "Connection reference",
    mcp_configuration: "MCP configuration",
    token_generation: "Token canary",
    agent_lease: "Agent lease canary",
  }))
    view.kind.append(new Option(label, value));
  const refresh = async (verb: "canary-status" | "canary-clear") => {
    try {
      show(view, await client.manage({ verb }, view.current.input.value));
    } finally {
      view.current.input.value = "";
    }
  };
  root.append(
    element("h3", "Controlled canaries"),
    element(
      "p",
      "Detection-only synthetic validators. No real vault, connectors, or production authority. Reading an exported file is not observable. Remove an offline detector separately with opensesame-id canary uninstall --config FILE. Management requires one verified password protector and no additional factors.",
    ),
    view.current.wrapper,
    view.kind,
    action("Refresh canary status", () => refresh("canary-status"), say),
    action("Create and export canary", () => create(view), say),
    view.rows,
    view.events,
    issuedPanel(client, () => view.current.input.value, say),
    action("Clear canary observations", () => refresh("canary-clear"), say),
  );
  return root;
}
