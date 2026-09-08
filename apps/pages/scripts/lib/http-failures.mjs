/** Admit one browser-generated console error for the exact tested SPA document. */
export function observeHttpFailures(page, record, expectedFallbackUrl) {
  let fallbackObserved = false;
  let fallbackConsoleObserved = false;
  page.on("response", (response) => {
    if (response.status() < 400) return;
    const request = response.request();
    if (
      response.status() === 404 &&
      response.url() === expectedFallbackUrl &&
      request.isNavigationRequest() &&
      request.resourceType() === "document" &&
      request.frame() === page.mainFrame() &&
      !fallbackObserved
    ) {
      fallbackObserved = true;
      record("EXPECTED-FALLBACK", response.url());
      return;
    }
    record("HTTP-ERROR", `${response.status()} ${response.url()}`);
  });
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    if (
      fallbackObserved &&
      !fallbackConsoleObserved &&
      message.location().url === expectedFallbackUrl &&
      message.text() ===
        "Failed to load resource: the server responded with a status of 404 (Not Found)"
    ) {
      fallbackConsoleObserved = true;
      record("EXPECTED-FALLBACK-CONSOLE", expectedFallbackUrl);
      return;
    }
    record("console-error", message.text().slice(0, 400));
  });
}
