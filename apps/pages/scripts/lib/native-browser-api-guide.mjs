/** Exercise the compiled selected token guide through the real provider form. */
const RAILWAY_GUIDES = {
  account: ["select No workspace", "every Railway resource"],
  workspace: ["select the workspace", "same workspace", "only that workspace"],
  project: [
    "project settings → Tokens",
    "chosen environment",
    "that project environment",
  ],
};

export async function nativeApiGuideJourney(page, harness, fixture) {
  const guide = page.locator("details").filter({
    has: page.locator("summary").filter({ hasText: /^Sign-in help$/ }),
  });
  if (!(await guide.count())) return;
  await guide.locator("summary").click();
  if (fixture.providerId === "railway") {
    const selector = page.getByLabel("Credential type", { exact: true });
    for (const variant of fixture.preset.credentialVariants) {
      await selector.selectOption(variant.id);
      const text = await guide.innerText();
      harness.check(
        RAILWAY_GUIDES[variant.id]?.every((phrase) => text.includes(phrase)) ===
          true,
        `railway: ${variant.label} shows its own documented setup guide`,
      );
      harness.check(
        variant.id === "account" || !text.includes("No workspace"),
        `railway: ${variant.label} never presents the account-only No workspace instruction`,
      );
    }
    await selector.selectOption(fixture.variant?.id ?? "account");
  }
  const text = await guide.innerText();
  harness.check(
    !/\*\*|`|\[[^\]]+\]\(https?:/.test(text),
    `${fixture.providerId}: setup guide renders provider instructions without raw Markdown syntax`,
  );
  const links = await guide
    .locator("a")
    .evaluateAll((nodes) =>
      nodes.map((node) => ({ href: node.href, rel: node.rel })),
    );
  harness.check(
    links.every(
      (link) =>
        link.href.startsWith("https:") &&
        link.rel.includes("noopener") &&
        link.rel.includes("noreferrer"),
    ),
    `${fixture.providerId}: official guide links keep HTTPS and isolated navigation`,
  );
}
