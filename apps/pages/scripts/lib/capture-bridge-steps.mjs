/**
 * Evidence of the connector bridge's page side (ADR 0199) in every state the
 * extension can leave it in, without the extension: a screen that names
 * `bridgeStub` gets a stand-in for the relay in its window, answering the
 * three questions the way the extension's relay does (and nothing else). The
 * extension itself is proved in a real Chromium by its own end-to-end test;
 * this is the app's side of the same wire.
 *
 *   "bridgeStub": { "granted": ["api.sendgrid.com"] }
 *
 * A screen with no `bridgeStub` has no bridge at all: nothing answers.
 */
const CHANNEL = "opensesame.connector-bridge";

/** Installed before the app loads, so its first question is answered. */
function installRelay({ channel, granted, status, body }) {
  window.addEventListener("message", (event) => {
    const data = event.data;
    if (
      event.source !== window ||
      !data ||
      data.channel !== channel ||
      data.direction !== "request"
    )
      return;
    const reply = (result) =>
      window.postMessage(
        {
          channel,
          version: 1,
          direction: "response",
          id: data.id,
          ok: true,
          result,
        },
        window.location.origin,
      );
    if (data.op === "hello")
      reply({
        bridge: "opensesame-connector-bridge",
        version: "0.1.0",
        granted,
      });
    else if (data.op === "need") reply({ pending: data.hosts });
    else if (data.op === "fetch")
      reply({
        status,
        headers: [["content-type", "application/json"]],
        body,
      });
  });
}

export async function stubJourneyBridge(page, screen) {
  if (!screen.bridgeStub) return;
  const { granted = [], status = 200, body = "{}" } = screen.bridgeStub;
  await page.addInitScript(installRelay, {
    channel: CHANNEL,
    granted,
    status,
    body,
  });
  console.log(`  bridge stand-in: allows ${granted.join(", ") || "no host"}`);
}
