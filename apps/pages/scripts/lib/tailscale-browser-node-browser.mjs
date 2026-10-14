/** Real SDK/control/DERP/native-peer UI journey; caller owns actual fixture processes. */
export async function exerciseTailscaleBrowserNode({
  page,
  check,
  hostname,
  controlURL,
  authKey,
  peerURL,
  peerObserved,
  lockAndUnlock,
}) {
  const panel = page.getByRole("region", { name: "Tailscale browser node" });
  // section has a heading and accessible label, so browsers expose it as a region.
  await panel
    .getByLabel("Browser node hostname", { exact: true })
    .fill(hostname);
  await panel
    .getByLabel("Tailscale control server", { exact: true })
    .fill(controlURL);
  await panel
    .getByText("Join with an existing auth key", { exact: true })
    .click();
  const secret = panel.getByLabel("Optional node auth key", { exact: true });
  await secret.fill(authKey);
  check(
    (await secret.getAttribute("type")) === "password",
    "browser-node auth key stays concealed",
  );
  await panel
    .getByRole("button", { name: "Connect browser node", exact: true })
    .click();
  await panel
    .getByRole("img", { name: /^Connected: / })
    .waitFor({ timeout: 90_000 });
  check(
    (await secret.inputValue()) === "",
    "transient browser auth key is cleared after submission",
  );
  await panel.getByLabel("Tailnet service URL", { exact: true }).fill(peerURL);
  await panel
    .getByRole("button", { name: "Test tailnet service", exact: true })
    .click();
  await panel
    .getByRole("img", { name: /^HTTP 200 · / })
    .waitFor({ timeout: 45_000 });
  check(
    await peerObserved(),
    "real native tailnet peer received the SDK GET through DERP",
  );
  if (lockAndUnlock) {
    await lockAndUnlock();
    await panel.waitFor();
    check(
      (await page.getByRole("img", { name: /^Connected: / }).count()) === 0,
      "locking terminates the node and does not silently reconnect on unlock",
    );
  } else {
    await panel
      .getByRole("button", { name: "Disconnect browser node", exact: true })
      .click();
    check(
      (await panel.getByRole("img", { name: /^Connected: / }).count()) === 0,
      "disconnect removes node authorization/status and terminates its worker",
    );
  }
}
