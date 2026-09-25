/**
 * Capture verbs for the authenticator hand-off (`/invoke/:kind`, ADR 0140
 * plan step 10): what the page's links point at, and every request the page
 * makes off its own origin — the claim that a request URI is handed on,
 * never fetched, is read from the browser, not from the diff.
 */

/** The origin of the document the page is on, or `null` before it has one. */
function pageOrigin(page) {
  try {
    const { origin } = new URL(page.url());
    return origin === "null" ? null : origin;
  } catch {
    return null;
  }
}

export function invokeSteps() {
  return {
    /**
     * From now on, print every request this page makes to another origin
     * (the stand-in Identity API included), as it is made.
     */
    async watchRequests(page) {
      page.on("request", (request) => {
        const url = new URL(request.url());
        if (url.protocol !== "https:" && url.protocol !== "http:") return;
        // The journey's own `arrive` loads, not something the page asked for.
        if (
          request.isNavigationRequest() &&
          request.frame() === page.mainFrame()
        )
          return;
        if (url.origin === pageOrigin(page)) return;
        console.log(
          `  request: ${request.method()} ${url.origin}${url.pathname}`,
        );
      });
    },
    /** Print each link in `main`: its accessible name and where it points. */
    async links(page) {
      const seen = await page
        .locator("main a")
        .evaluateAll((nodes) =>
          nodes.map(
            (node) =>
              `${node.getAttribute("aria-label") ?? node.textContent?.trim()} → ${node.getAttribute("href")}`,
          ),
        );
      console.log(`  links: ${seen.join(" | ") || "none"}`);
    },
  };
}
