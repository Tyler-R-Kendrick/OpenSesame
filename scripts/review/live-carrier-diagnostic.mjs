/** Failure-only, value-free observations of the actual carrier form. */
export async function diagnoseCarrier(routes, carrier) {
  const evidence = await routes.evaluate((root, expected) => {
    const url = root.querySelector("#live-carrier-url");
    const kind = root.querySelector("#live-carrier-kind");
    const signIn = root.querySelector("#live-nats-sign-in");
    const selected = ["none", "mint", "creds"].includes(signIn?.value)
      ? signIn.value
      : null;
    let protocol = null;
    try {
      const parsed = new URL(url?.value ?? "");
      protocol = ["https:", "http:", "wss:", "ws:"].includes(parsed.protocol)
        ? parsed.protocol
        : "other";
    } catch {}
    const submit = [...root.querySelectorAll("button")].find(
      (button) => button.getAttribute("aria-label") === "Add the carrier",
    );
    return {
      kindMatchesExpected: kind?.value === expected.kind,
      expectedKind: ["nats", "mqtt", "nostr", "ntfy"].includes(expected.kind)
        ? expected.kind
        : "other",
      urlMatchesExpected: url?.value === expected.url,
      urlTrackerMatchesExpected: url?._valueTracker?.getValue() === expected.url,
      urlFocused: root.ownerDocument.activeElement === url,
      urlLength: url?.value.length ?? null,
      urlProtocol: protocol,
      urlBrowserValid: url?.validity.valid ?? null,
      selectedSignIn: selected,
      accountFilled: Boolean(root.querySelector("#live-nats-account")?.value),
      signingKeyFilled: Boolean(root.querySelector("#live-nats-signing-key")?.value),
      jwtFilled: Boolean(root.querySelector("#live-nats-jwt")?.value),
      seedFilled: Boolean(root.querySelector("#live-nats-seed")?.value),
      submitDisabled: submit?.disabled ?? null,
      invalidAddressMark: Boolean(root.querySelector('[aria-label="Needs a secure address"]')),
    };
  }, { kind: carrier.kind, url: carrier.url });
  console.log(`Carrier failure diagnostic: ${JSON.stringify(evidence)}`);
}

/** The address field shares the same asynchronous submit/reset lifecycle. */
export async function diagnoseAddress(routes, address) {
  const evidence = await routes.evaluate((root, expected) => {
    const input = root.querySelector("#live-address");
    const submit = root.querySelector('[aria-label="Add the address"]');
    return {
      valueMatchesExpected: input?.value === expected,
      trackerMatchesExpected: input?._valueTracker?.getValue() === expected,
      valueLength: input?.value.length ?? null,
      browserValid: input?.validity.valid ?? null,
      focused: root.ownerDocument.activeElement === input,
      submitDisabled: submit?.disabled ?? null,
      invalidAddressMark: Boolean(root.querySelector('[aria-label="Not an IP address"]')),
    };
  }, address);
  console.log(`Address failure diagnostic: ${JSON.stringify(evidence)}`);
}
