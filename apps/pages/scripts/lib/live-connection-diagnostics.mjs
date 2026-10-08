/** Report both live panels while preserving the original connection failure. */
export async function reportConnectionFailure(owner, joiner, error) {
  // Say what each side showed, so a connection that never forms reads as
  // one, not as a bare "element(s) not found".
  for (const [who, page] of [
    ["owner", owner],
    ["joiner", joiner],
  ]) {
    const shown = await page
      .locator("#live-session, .live-join")
      .first()
      .innerText({ timeout: 2000 })
      .catch(() => "(no live panel)");
    console.error(`${who} showed: ${shown.replace(/\s+/g, " ").slice(0, 400)}`);
  }
  throw error;
}
