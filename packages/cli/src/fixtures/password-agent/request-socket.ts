/** Private test protocol, never user CLI output. */
import { writeSync } from "node:fs";
import { prepareRequest } from "@opensesame/app-core/lib/password-agent/request.js";
import { sendPrivateRequest } from "../../parity-request-node.js";
const prepared = prepareRequest({
  url: "https://request.example/private?query=canary",
  reference: "op://vault/item/field",
});
prepared.url.port = process.argv[2] ?? "";
const result = await sendPrivateRequest(
  prepared,
  "private-canary",
  { address: "127.0.0.1", family: 4 },
  {
    maxBytes: Number(process.argv[3] ?? 65536),
    timeoutMs: Number(process.argv[4] ?? 15000),
  },
).then(
  (response) => ({ status: response.status, bytes: response.bytes }),
  () => ({ error: true }),
);
writeSync(1, JSON.stringify(result));
