/**
 * Arm Linear's authorize navigation on the popup event, before the click
 * settles. The consent window opens synchronously; durable preparation runs
 * before `location.replace`, and authorize's `finally` releases the window.
 * Waiting for the URL only after `click` resolves lets that release close
 * the page before `waitForURL` is listening.
 *
 * `observePopup` runs in that same turn, before `waitForURL`, so a caller can
 * see a superseded window close even when navigation rejects while the click
 * is still pending. The navigation rejection is held until the click settles
 * so it is not an unhandled rejection.
 */
export const CONSENT_POPUP_TIMEOUT_MS = 60_000;

const AUTHORIZE_URL = "https://linear.app/oauth/authorize?**";

export async function openLinearConsentPopup(page, button, observePopup) {
  const popupPromise = page.waitForEvent("popup", {
    timeout: CONSENT_POPUP_TIMEOUT_MS,
  });
  let navigationError = null;
  const navigated = popupPromise.then((popup) => {
    observePopup?.(popup);
    return popup
      .waitForURL(AUTHORIZE_URL, {
        timeout: CONSENT_POPUP_TIMEOUT_MS,
        waitUntil: "commit",
      })
      .then(() => popup);
  });
  const settled = navigated.then(
    (popup) => popup,
    (error) => {
      navigationError = error;
      return null;
    },
  );
  await button.click();
  const popup = await settled;
  if (navigationError) throw navigationError;
  if (!popup)
    throw new Error("consent popup closed before Linear authorize URL");
  return popup;
}
