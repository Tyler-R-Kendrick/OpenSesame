// A Bitwarden client's live-sync connection, for the hub oracle (ADR 0148 §7).
//
// Connects exactly as bitwarden/clients' SignalRConnectionService does —
// Microsoft's SignalR client, pinned to the version Bitwarden pins, over
// WebSockets with negotiation skipped and the MessagePack hub protocol — and
// prints one JSON line per event on stdout: {"event":"connected"}, each
// ReceiveMessage as {"event":"message","type":…,"userId":…,"date":…}, and
// {"event":"closed"}.
//
// With HUB_TOKEN unset it is the anonymous hub a device asking to sign in
// waits on, as bitwarden/clients' AnonymousHubService connects to it, and
// each AuthRequestResponseRecieved prints as {"event":"answered",…}.
//
// Environment: OPENSESAME_SIGNALR_DIR (where the pinned packages are
// installed), HUB_URL (the hub's URL, with ?Token= for the anonymous hub),
// HUB_TOKEN.
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

const options = {
  skipNegotiation: true,
  transport: signalr.HttpTransportType.WebSockets,
};
if (process.env.HUB_TOKEN) {
  options.accessTokenFactory = () => process.env.HUB_TOKEN;
}
const connection = new signalr.HubConnectionBuilder()
  .withUrl(process.env.HUB_URL, options)
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
connection.on("AuthRequestResponseRecieved", (data) => {
  say({
    event: "answered",
    type: data.Type,
    id: data.Payload?.Id ?? null,
    userId: data.UserId ?? null,
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
