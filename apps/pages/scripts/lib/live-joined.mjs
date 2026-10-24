/**
 * Where a joiner stands once the two browsers meet (ADR 0150). The app opens
 * the joiner's own vault on joining (893f1831c): its list carries a banner
 * marked "In a live session", and the prompt's lit share key, "Open live
 * session", leads back to what the owner shared, drawn at every width. The
 * session's own status, "Joined <session>", is on that page of shared items,
 * and is on screen only until the vault opens unless the joiner goes back.
 *
 * This is the one definition of "joined" the walks read, waiting for a join
 * or asserting there was none, so none of them races the move to the vault.
 */

/** The session's status on the page of shared items, for any session. */
const JOINED = /^Joined /;

/** The walks' session's status on the page of shared items. */
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
 * Every mark that says the joiner is in a session, wherever the app has put
 * them: the status on the shared items, or their vault's banner. Each is
 * drawn only while the session is joined, so each is read as drawn. A walk
 * that must never join counts these and finds none.
 */
export const joinedMarks = (page) =>
  page.getByRole("img", { name: JOINED }).or(inLiveSession(page));

/** Resolves once the joiner is in the session; rejects after `timeout`. */
export async function joinedSession(page, timeout = 45_000) {
  await joinedMarks(page).first().waitFor({ state: "attached", timeout });
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
