/** Admit only registered callback 404s and deliberately failed provider requests. */
export function linearFallbacks(harness) {
  const counts = new Map();
  const admit = (kind, detail) => {
    const key = `${kind}:${detail}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
    harness.record("EXPECTED-LINEAR-FALLBACK", detail);
  };
  return {
    observe(page, authority) {
      const documents = new Set();
      const apiErrors = new Map();
      page.on("response", (response) => {
        const request = response.request();
        if (authority.expectedResponses.get(request) === response.status()) {
          authority.expectedResponses.delete(request);
          const reason = new Map([
            [400, "Bad Request"],
            [503, "Service Unavailable"],
          ]).get(response.status());
          const detail = `Failed to load resource: the server responded with a status of ${response.status()} (${reason})`;
          apiErrors.set(response.url(), [
            ...(apiErrors.get(response.url()) ?? []),
            detail,
          ]);
          admit("HTTP-ERROR", `${response.status()} ${response.url()}`);
        }
        if (
          response.status() === 404 &&
          authority.expectedCallbacks.has(response.url()) &&
          request.isNavigationRequest() &&
          request.resourceType() === "document" &&
          request.frame() === page.mainFrame()
        ) {
          documents.add(response.url());
          admit("HTTP-ERROR", `404 ${response.url()}`);
        }
      });
      page.on("console", (message) => {
        const pending = apiErrors.get(message.location().url) ?? [];
        const index = pending.indexOf(message.text());
        if (message.type() === "error" && index >= 0) {
          pending.splice(index, 1);
          admit("console-error", message.text());
        }
        if (
          message.type() === "error" &&
          documents.has(message.location().url) &&
          message.text() ===
            "Failed to load resource: the server responded with a status of 404 (Not Found)"
        ) {
          documents.delete(message.location().url);
          admit("console-error", message.text());
        }
      });
    },
    unexpected(entry) {
      const key = `${entry.kind}:${entry.detail}`;
      const remaining = counts.get(key) ?? 0;
      if (remaining === 0) return true;
      counts.set(key, remaining - 1);
      return false;
    },
  };
}
