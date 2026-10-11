/**
 * Capture verbs for a ceremony sheet and the provider behind it. The journeys
 * run with no network, so the one request a model provider's Add sheet makes —
 * the call that proves a pasted key — is answered here, the way the Pages
 * tests answer it: the sheet still sends it, reads the answer and draws what
 * it makes of it. Nothing on screen is placed by hand.
 */

const PROVIDER_CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization, content-type",
  "access-control-allow-methods": "GET, POST, OPTIONS",
};

export function sheetSteps({ press }) {
  return {
    /**
     * Answer `GET https://<host><path>` with an empty model list and the
     * provider's CORS headers, and its preflight.
     */
    async stubModelProvider(page, { host, path }) {
      await page.route(`https://${host}/**`, (route) => {
        const request = route.request();
        if (request.method() === "OPTIONS")
          return route.fulfill({ status: 204, headers: PROVIDER_CORS });
        if (new URL(request.url()).pathname !== path)
          return route.fulfill({
            status: 404,
            headers: PROVIDER_CORS,
            body: "not found",
          });
        return route.fulfill({
          status: 200,
          headers: { ...PROVIDER_CORS, "content-type": "application/json" },
          body: JSON.stringify({ object: "list", data: [] }),
        });
      });
    },
    /**
     * Press a key inside the open sheet, when this build has one. A key with
     * the same name can sit on the page behind it, so the sheet is named.
     */
    async pressInSheetOptional(page, name) {
      const key = page
        .getByRole("dialog")
        .getByRole("button", { name, exact: true })
        .first();
      if (!(await key.count()) || !(await key.isEnabled())) return;
      await press(key);
      await page.waitForTimeout(1000);
    },
  };
}
