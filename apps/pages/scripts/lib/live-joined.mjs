/**
 * Where a joiner stands once the two browsers meet (ADR 0150). The app opens
 * the joiner's own vault on joining (893f1831c): its list carries a banner
 * marked "In a live session", and the prompt's lit share key, "Open live
 * session", leads back to what the owner shared, drawn at every width. The
 * session's own status, "Joined Team", is on that page of shared items, and
 * is on screen only until the vault opens unless the joiner goes back to it.
 */

/** The session's status on the page of shared items. */
export const joinedTeam = (page) =>
  page.getByRole("img", { name: "Joined Team" });

/**
 * The joiner's own vault, in a joined session: its banner's mark. On a phone
 * the vault shows its tree and the list holding the banner is out of view,
 * so the mark is found as drawn, hidden or not.
 */
export const inLiveSession = (page) =>
  page.getByRole("img", {
    name: "In a live session",
    exact: true,
    includeHidden: true,
  });

/**
 * Resolves once the joiner is in the session, on the shared items or in
 * their own vault, wherever the app has put them; rejects after `timeout`.
 * Each mark is drawn only while the session is joined, so each is waited on
 * as drawn.
 */
export async function joinedSession(page, timeout = 45_000) {
  await joinedTeam(page)
    .or(inLiveSession(page))
    .first()
    .waitFor({ state: "attached", timeout });
}

/**
 * The joiner goes back to what the owner shared, as a person does once the
 * app has opened their vault: the prompt's "Open live session" key.
 */
export async function opensSharedItems(page, timeout = 45_000) {
  await inLiveSession(page).waitFor({ state: "attached", timeout });
  await page
    .getByRole("button", { name: "Open live session", exact: true })
    .filter({ visible: true })
    .click();
  await joinedTeam(page).waitFor({ timeout: 15_000 });
}
