/** Actual probe results and shared notice operations; no state or response injection. */
export async function assertMembership(c, page, panel, width, stage) {
  await c
    .expect(panel.getByRole("img", { name: /^Connected: / }))
    .toHaveCount(1);
  await c
    .expect(
      page.locator(".conn-settings__head").getByRole("img", {
        name: "Browser node connected",
        exact: true,
      }),
    )
    .toHaveCount(1);
  c.h.check(
    c.workers.filter((w) => w.width === width && !w.closed).length === 1,
    `${width} ${stage}: current authenticated node and single emitted worker remain live`,
  );
  const text = await page.locator("body").innerText();
  c.h.check(
    !text.includes(c.fixture.nonce) &&
      !text.includes('"source":"real-native-tailscale-peer"'),
    `${width} ${stage}: provider response body and nonce are not rendered`,
  );
}
export async function readNotices(c, page, width, stage) {
  const dialog = page.getByRole("dialog", {
    name: "Notifications",
    exact: true,
  });
  if (!(await dialog.isVisible())) {
    if (width === 390) {
      await page.getByRole("button", { name: /^More/ }).click();
      await page
        .getByRole("dialog", { name: "More", exact: true })
        .getByRole("button", { name: /^Notifications/ })
        .click();
    } else await page.getByRole("button", { name: /^Notifications/ }).click();
  }
  await dialog.waitFor();
  const cards = await dialog.locator(".notice-card").evaluateAll((nodes) =>
    nodes.map((n) => ({
      title: n.querySelector("h3")?.innerText ?? null,
      body: n.querySelector("p")?.innerText ?? null,
      role: n.getAttribute("role"),
      className: n.className,
    })),
  );
  c.notices.push({ width, stage, cards });
  const errors = cards.filter(
    (n) => n.title?.includes("Tailscale") && n.body?.includes("HTTP 404"),
  );
  c.h.check(
    errors.length ===
      (c.phase === "after" && stage === "missing-service" ? 1 : 0),
    `${width} ${stage}: actual shared Tailscale notice matches service outcome`,
  );
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  await c.expect(dialog).toHaveCount(0);
}
async function probeGeometry(page, marker) {
  const markerRect = await marker.boundingBox();
  const scrollers = await page.evaluate(() =>
    [...document.querySelectorAll("*")]
      .filter((n) => n.scrollTop > 0)
      .map((n) => ({
        tag: n.tagName,
        className: n.className,
        top: n.scrollTop,
        clientHeight: n.clientHeight,
        scrollHeight: n.scrollHeight,
      })),
  );
  return { markerRect, scrollers };
}
async function revealProbe(c, page, marker, width) {
  await marker.scrollIntoViewIfNeeded();
  if (width === 390) await marker.tap();
  else await marker.click();
  await c
    .expect(page.locator(".status-bubble"))
    .toHaveText(await marker.getAttribute("aria-label"));
  return probeGeometry(page, marker);
}
async function probeOrder(c, marker, width, error) {
  if (c.phase !== "after" || !error) return null;
  const order = await marker.evaluate((mark) => {
    const form = mark.closest("form");
    const service = [...form.querySelectorAll("input")].find((n) =>
      [...n.labels].some(
        (label) => label.textContent.trim() === "Tailnet service URL",
      ),
    );
    const action = [...form.querySelectorAll("button")].find(
      (n) =>
        n.getAttribute("aria-label") === "Test tailnet service" ||
        n.textContent.trim() === "Test tailnet service",
    );
    return {
      serviceBeforeResult:
        !!service &&
        !!(
          service.compareDocumentPosition(mark) &
          Node.DOCUMENT_POSITION_FOLLOWING
        ),
      testBeforeResult:
        !!action &&
        !!(
          action.compareDocumentPosition(mark) &
          Node.DOCUMENT_POSITION_FOLLOWING
        ),
    };
  });
  c.h.check(
    order.serviceBeforeResult,
    `${width}: actual service404 error follows the service URL in DOM order`,
  );
  c.h.check(
    order.testBeforeResult,
    `${width}: actual service404 error follows Test in DOM order`,
  );
  return order;
}
export async function serviceProbe(c, page, panel, width, pathname, stage) {
  c.h.setStep(`${c.phase}-${width}-${stage}`);
  const previous = c.fixture.peer.length;
  const url = new URL(c.fixture.peerUrl);
  url.pathname = pathname;
  await panel.getByLabel("Tailnet service URL", { exact: true }).fill(url.href);
  await panel
    .getByRole("button", { name: "Test tailnet service", exact: true })
    .click();
  const size = JSON.stringify({
    source: "real-native-tailscale-peer",
    nonce: c.fixture.nonce,
    path: pathname,
  }).length;
  const status = pathname === "/missing" ? 404 : 200;
  const error = c.phase === "after" && status === 404;
  const label = error
    ? "Tailnet service returned HTTP 404."
    : `HTTP ${status} · ${size} characters received through Tailscale`;
  const marker = panel.getByRole("img", { name: label, exact: true });
  await marker.waitFor({ timeout: 45000 });
  c.h.check(
    c.fixture.peer
      .slice(previous)
      .some((r) => r.method === "GET" && r.path === pathname),
    `${width} ${stage}: native peer independently received actual ${pathname} request`,
  );
  c.h.check(
    await marker.evaluate(
      (n, tone) => n.classList.contains(`status-mark--${tone}`),
      error ? "err" : "ok",
    ),
    `${width} ${stage}: literal HTTP${status} result has observed ${error ? "error" : "ok"} tone`,
  );
  const domOrder = await probeOrder(c, marker, width, error);
  await assertMembership(c, page, panel, width, stage);
  await readNotices(c, page, width, stage);
  const geometry = await revealProbe(c, page, marker, width);
  const measured = await c.journey.capture(page, width, stage);
  c.probes.push({
    width,
    stage,
    pathname,
    status,
    label,
    geometry,
    domOrder,
    measuredStatuses: measured.statuses,
  });
}
