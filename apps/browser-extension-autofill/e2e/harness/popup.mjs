// Driving the real toolbar popup the way a person does: real clicks on its own
// keys (`cdp.mjs` says why it cannot be a tab). The popup opens for the tab in
// view, so the login page is brought to the front first; `openPopup` is the
// background API a toolbar click calls.
import { attachPopup, connectBrowser } from "./cdp.mjs";

export const WORDS = {
  ready: "Ready",
  filled: "Filled",
  siteOff: "Autofill is off on this site",
  pluginOff: "The autofill plugin is off on this computer",
  noPage: "This tab has no web page to fill",
  notPaired: "Not paired with this computer yet",
  noMatch: "No entry is stored for this exact origin",
  passkey: "This page offers a passkey. Use it instead",
  hidden: "The field is not visible, so nothing was filled",
  frame: "Only fields in the page itself are filled, never in a frame",
};

const seen = new WeakMap();

/** Open the popup for `login`, wait for it to read its status, and start recording replies. */
export async function openPopup(session, login) {
  const state = seen.get(session) ?? { browser: null, known: new Set() };
  seen.set(session, state);
  if (!state.browser) {
    state.browser = await connectBrowser(session.profile);
    session.cleanups.push(() => state.browser.close());
  }
  await login.bringToFront();
  const worker = await session.worker();
  await worker.evaluate(() => chrome.action.openPopup());
  const popup = await attachPopup(state.browser, session.popupUrl, state.known);
  state.known.add(popup.targetId);
  await popup.waitFor(
    (noPage) =>
      document.getElementById("origin")?.textContent !== "" ||
      document.getElementById("mark")?.getAttribute("aria-label") === noPage,
    WORDS.noPage,
  );
  // Every reply the background gives this popup, so a test can read outcome
  // codes and prove none of them ever holds a value.
  await popup.evaluate(() => {
    const replies = [];
    globalThis.__replies = replies;
    const send = chrome.runtime.sendMessage.bind(chrome.runtime);
    chrome.runtime.sendMessage = async (message) => {
      const reply = await send(message);
      replies.push(reply);
      return reply;
    };
  });
  return popup;
}

export const mark = (popup) =>
  popup.evaluate(() =>
    document.getElementById("mark").getAttribute("aria-label"),
  );

export const waitMark = (popup, words) =>
  popup.waitFor(
    (wanted) =>
      document.getElementById("mark")?.getAttribute("aria-label") === wanted,
    words,
  );

export const originShown = (popup) =>
  popup.evaluate(() => document.getElementById("origin").textContent);

/** Whether the key or field `#id` is drawn (not `hidden`). */
export const isShown = (popup, id) =>
  popup.evaluate((one) => !document.getElementById(one).hidden, id);

export const siteIsOn = async (popup) =>
  (await popup.evaluate(() =>
    document.getElementById("site").getAttribute("aria-checked"),
  )) === "true";

/** Press the fill key and return the background's answer (an outcome code). */
export async function pressFill(popup) {
  const before = await popup.evaluate(() => globalThis.__replies.length);
  await popup.click("#go");
  await popup.waitFor((n) => globalThis.__replies.length > n, before);
  return popup.evaluate(() => globalThis.__replies.at(-1));
}

/**
 * Send the message the fill key sends, for a state where the key is hidden or
 * disabled: the background must refuse there on its own account, whatever the
 * popup drew.
 */
export const sendFill = (popup, reference) =>
  popup.evaluate((ref) => {
    const message = { type: "opensesame.fill", op: "trigger" };
    if (ref !== null) message.reference = ref;
    return chrome.runtime.sendMessage(message);
  }, reference ?? null);

/** Everything the popup has shown or been told, as one string, for leak checks. */
export const everythingShown = (popup) =>
  popup.evaluate(
    () =>
      `${document.documentElement.outerHTML}\n${JSON.stringify(globalThis.__replies)}\n${[
        ...document.querySelectorAll("[aria-label],[title]"),
      ]
        .map(
          (el) =>
            `${el.getAttribute("aria-label")} ${el.getAttribute("title")}`,
        )
        .join("\n")}`,
  );

/**
 * The switch, then the pairing ceremony, exactly as a person walks it: press
 * the site switch (the browser's grant is already held, so the request
 * resolves), press the pairing key, read the code off the popup, approve it
 * on the daemon's operator channel, press the pairing key again.
 */
export async function switchOnAndPair(session, popup) {
  await popup.click("#site");
  await waitMark(popup, WORDS.notPaired);
  await popup.click("#pair");
  await popup.waitFor(
    () => document.getElementById("code")?.textContent !== "",
  );
  session.daemon.approve(
    await popup.evaluate(() => document.getElementById("code").textContent),
  );
  await popup.click("#pair");
  await waitMark(popup, WORDS.ready);
}
