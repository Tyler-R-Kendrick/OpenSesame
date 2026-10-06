/** Concurrent authority test protocol; no credentials are accessed. */
import { writeSync } from "node:fs";
import { describeRequest } from "@opensesame/app-core/lib/password-agent/request.js";
import { openLeaseStore } from "../../parity-lease-node.js";
const store = await openLeaseStore();
try {
  const binding = describeRequest({
    url: "https://example.com/race",
    reference: "op://Automation/Database/password",
  });
  const claimed = await store
    .claim(
      "race",
      binding,
      { id: "a".repeat(26), version: 1 },
      await store.principal(),
      Date.now(),
    )
    .then(
      () => true,
      () => false,
    );
  writeSync(1, JSON.stringify({ claimed }));
} finally {
  store.close();
}
