/** Capture the visible diagnostic and its text in one browser turn. */
export async function observePeeringDiagnostic(page, selector) {
  const observation = await page.waitForFunction(
    (query) => {
      const node = document.querySelector(query);
      if (!node) return null;
      const { width, height } = node.getBoundingClientRect();
      const visibility = getComputedStyle(node).visibility;
      if (!width || !height || /hidden|collapse/.test(visibility)) return null;
      return { text: node.textContent ?? "" };
    },
    selector,
    { timeout: 45_000 },
  );
  try {
    return (await observation.jsonValue()).text;
  } finally {
    await observation.dispose();
  }
}
