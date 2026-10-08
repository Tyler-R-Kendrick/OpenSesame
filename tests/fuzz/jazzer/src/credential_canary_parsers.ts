import {
  decodePresentedId,
  encodePresentedId,
  parseControlledCanaryReference,
} from "@opensesame/app-core/lib/credential-canaries/identifier.js";
import {
  controlledMcpResponse,
  parseControlledMcpRequest,
  validateControlledMcpRequest,
} from "@opensesame/app-core/lib/credential-canaries/mcp-protocol.js";
import { parseControlledValidatorBinding } from "@opensesame/app-core/lib/credential-canaries/validator-binding.js";
import { closedKeys, invariant, parsed } from "./security-protocol/oracles.js";

export function fuzz(data: Buffer): void {
  const mode = (data[0] ?? 0) % 4;
  const raw = data.subarray(1, 8194).toString("utf8");
  if (mode === 0) {
    const accepted = parsed(() => decodePresentedId(raw));
    if (!accepted) return;
    invariant(accepted.value.length === 32, "identifier length");
    invariant(
      encodePresentedId(accepted.value) === raw,
      "noncanonical identifier",
    );
  } else if (mode === 1) {
    const accepted = parsed(() => parseControlledCanaryReference(raw));
    if (!accepted || accepted.value === null) return;
    invariant(raw === `oscanary:v1:${accepted.value}`, "reference namespace");
    invariant(
      encodePresentedId(decodePresentedId(accepted.value)) === accepted.value,
      "reference encoding",
    );
  } else if (mode === 2) {
    const accepted = parsed(() => parseControlledValidatorBinding(raw));
    if (!accepted) return;
    const b = accepted.value;
    invariant(Buffer.byteLength(raw, "utf8") <= 4096, "binding resource bound");
    closedKeys(b, ["v", "validatorId", "artifactId", "context", "digestB64"]);
    closedKeys(b.context, ["vaultIdentity", "kind", "generation"]);
    invariant(
      b.context.kind === "mcp_configuration",
      "non-MCP validator authority",
    );
    invariant(
      Buffer.from(b.digestB64, "base64").toString("base64") === b.digestB64,
      "noncanonical digest",
    );
  } else {
    const accepted = parsed(() =>
      validateControlledMcpRequest(parseControlledMcpRequest(raw)),
    );
    if (!accepted) return;
    const request = accepted.value;
    const reply = controlledMcpResponse(request);
    invariant(
      Buffer.byteLength(raw, "utf8") <= 4096,
      "MCP request resource bound",
    );
    if (request.method === "tools/list") {
      invariant(
        JSON.stringify(reply?.result) ===
          JSON.stringify({
            tools: [
              {
                name: "canary.status",
                description: "Read synthetic validator status",
                inputSchema: {
                  type: "object",
                  properties: {},
                  additionalProperties: false,
                },
              },
            ],
          }),
        "unexpected synthetic tool authority",
      );
    }
    if (request.method === "tools/call") {
      invariant(
        JSON.stringify(reply?.result) ===
          JSON.stringify({
            content: [
              {
                type: "text",
                text: '{"environment":"synthetic","status":"available"}',
              },
            ],
          }),
        "non-synthetic tool result",
      );
    }
  }
}
