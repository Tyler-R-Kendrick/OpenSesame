/** Admit only the exact synthetic provider refusals and deliberate cold SPA loads. */
export function nativeExpectedFailures(harness, page, authority) {
  const counts = new Map();
  const consoles = new Map();
  const reasons = new Map([
    [401, "Unauthorized"],
    [404, "Not Found"],
    [405, "Method Not Allowed"],
    [503, "Service Unavailable"],
  ]);
  function admit(kind, detail) {
    const key = `${kind}:${detail}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  page.on("response", (response) => {
    const request = response.request();
    const status = response.status();
    const provider = authority.state.expectedResponses.get(request) === status;
    const document =
      status === 404 &&
      authority.state.expectedDocuments.has(response.url()) &&
      request.isNavigationRequest() &&
      request.frame() === page.mainFrame();
    if (!provider && !document) return;
    authority.state.expectedResponses.delete(request);
    if (document) authority.state.expectedDocuments.delete(response.url());
    admit("HTTP-ERROR", `${status} ${response.url()}`);
    const detail = `Failed to load resource: the server responded with a status of ${status} (${reasons.get(status)})`;
    consoles.set(response.url(), [
      ...(consoles.get(response.url()) ?? []),
      detail,
    ]);
    harness.record(
      "EXPECTED-NATIVE-REFUSAL",
      `${status} compiled provider request or declared SPA reload`,
    );
  });
  page.on("console", (message) => {
    const pending = consoles.get(message.location().url) ?? [];
    const index = pending.indexOf(message.text());
    if (message.type() !== "error" || index < 0) return;
    pending.splice(index, 1);
    admit("console-error", message.text());
  });
  return (entry) => {
    const key = `${entry.kind}:${entry.detail}`;
    const remaining = counts.get(key) ?? 0;
    if (!remaining) return true;
    counts.set(key, remaining - 1);
    return false;
  };
}
