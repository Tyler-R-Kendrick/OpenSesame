// A Bitwarden client's live-sync connection, for the hub oracle (ADR 0148 §7).
//
// Connects exactly as bitwarden/clients' SignalRConnectionService does —
// Microsoft's SignalR client, pinned to the version Bitwarden pins, over
// WebSockets with negotiation skipped and the MessagePack hub protocol — and
// prints one JSON line per event on stdout: {"event":"connected"}, each
// ReceiveMessage as {"event":"message","type":…,"userId":…,"date":…}, and
// {"event":"closed"}.
//
// Environment: OPENSESAME_SIGNALR_DIR (where the pinned packages are
// installed), HUB_URL (the server URL's /notifications/hub), HUB_TOKEN.
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(
  path.join(process.env.OPENSESAME_SIGNALR_DIR, "package.json"),
);
const signalr = require("@microsoft/signalr");
const {
  MessagePackHubProtocol,
} = require("@microsoft/signalr-protocol-msgpack");

const say = (line) => process.stdout.write(`${JSON.stringify(line)}\n`);

const connection = new signalr.HubConnectionBuilder()
  .withUrl(process.env.HUB_URL, {
    accessTokenFactory: () => process.env.HUB_TOKEN,
    skipNegotiation: true,
    transport: signalr.HttpTransportType.WebSockets,
  })
  .withHubProtocol(new MessagePackHubProtocol())
  .configureLogging(signalr.LogLevel.None)
  .build();

connection.on("ReceiveMessage", (data) => {
  say({
    event: "message",
    type: data.Type,
    contextId: data.ContextId ?? null,
    userId: data.Payload?.UserId ?? null,
    date:
      data.Payload?.Date instanceof Date
        ? data.Payload.Date.toISOString()
        : null,
  });
});
connection.onclose(() => {
  say({ event: "closed" });
  process.exit(0);
});

try {
  await connection.start();
  say({ event: "connected" });
} catch (error) {
  say({ event: "refused", error: String(error?.message ?? error) });
  process.exit(0);
}
