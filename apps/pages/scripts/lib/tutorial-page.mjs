import { allowLoopbackDevelopment } from "./local-network-permission.mjs";

const PHONE = {
  viewport: { width: 390, height: 844 },
  hasTouch: true,
  isMobile: true,
  deviceScaleFactor: 2,
};

export function createTutorialPageFactory({
  browser,
  devUrl,
  harness,
  origin,
  tailnet,
}) {
  return async function newPage(width) {
    const device = width < 600 ? PHONE : { viewport: { width, height: 900 } };
    if (!devUrl) {
      const made = await harness.newPage(browser, {
        device,
        passthrough: tailnet ? [tailnet.url] : [],
      });
      const networkPermission = tailnet
        ? await allowLoopbackDevelopment(made.page, origin)
        : null;
      return { ...made, networkPermission };
    }
    const context = await browser.newContext(device);
    const page = await context.newPage();
    page.on("pageerror", (error) =>
      harness.record("PAGE-ERROR", String(error.message).slice(0, 300)),
    );
    return { page, context };
  };
}
