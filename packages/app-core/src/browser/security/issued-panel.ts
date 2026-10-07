import { z } from "zod";
import { contextSchema } from "../../lib/credential-canaries/protocol.js";
import type { securityClient } from "./client.js";
import { action, element } from "./dom.js";
const replySchema = z
  .object({
    issued: z
      .array(
        z
          .object({
            issuerRecordRef: z.string().max(128),
            context: contextSchema,
          })
          .strict(),
      )
      .max(16),
  })
  .strict();
/** Runtime-local inventory; no fake vendor token or raw identifier entry. */
export function issuedPanel(
  client: ReturnType<typeof securityClient>,
  password: () => string,
  say: (text: string) => void,
) {
  const root = element("section");
  const rows = element("ul");
  const refresh = async () => {
    const reply = replySchema.parse(
      JSON.parse(
        await client.manage({ verb: "canary-issued-status" }, password()),
      ),
    );
    rows.replaceChildren();
    for (const [index, record] of reply.issued.entries()) {
      const row = element(
        "li",
        `Revoked local agent lease ${index + 1}, generation ${record.context.generation}`,
      );
      row.append(
        action(
          `Monitor revoked lease ${index + 1}`,
          async () => {
            await client.manage(
              {
                verb: "canary-retire",
                issuerRecordRef: record.issuerRecordRef,
              },
              password(),
            );
            say(
              "Retired lease identifier enrolled. Local inventory clears on reload.",
            );
          },
          say,
        ),
      );
      rows.append(row);
    }
    if (!reply.issued.length)
      say(
        "No revoked local issuer identifiers are available in this running session.",
      );
  };
  root.append(action("Review revoked local agent leases", refresh, say), rows);
  return root;
}
