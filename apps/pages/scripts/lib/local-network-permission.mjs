/** Grant development network consent in this page's real Chromium context. */
export async function allowLoopbackDevelopment(
  page,
  origin,
  extraPermissions = [],
) {
  const cdp = await page.context().newCDPSession(page);
  try {
    const { targetInfo } = await cdp.send("Target.getTargetInfo");
    const permissions = [...extraPermissions, "localNetworkAccess"];
    const grant = (names) =>
      cdp.send("Browser.grantPermissions", {
        permissions: names,
        origin,
        browserContextId: targetInfo.browserContextId,
      });
    try {
      // Chrome 151 separates loopback from local-network access.
      // One grant preserves the caller's other permissions for this origin.
      await grant([...permissions, "loopbackNetwork"]);
    } catch (error) {
      if (!String(error).includes("Unknown permission type: loopbackNetwork"))
        throw error;
      await grant(permissions);
    }
    // Chromium revokes these overrides on detach. The page's context owns
    // this session until it closes, so retain it for the entire real journey.
    return cdp;
  } catch (error) {
    await cdp.detach();
    throw error;
  }
}
