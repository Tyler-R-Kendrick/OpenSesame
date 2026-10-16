/** Actual UI operations; no request interception or state injection. */
import fs from "node:fs";
import path from "node:path";

async function openNode(context, page) {
  const { visitBackendRoute, base } = context;
  await visitBackendRoute(page, base, "settings/connections/tailscale");
  const panel = page.getByRole("region", {
    name: "Tailscale browser node",
    exact: true,
  });
  await panel.waitFor();
  return panel;
}
async function capture(context, page, width, step, { picture = true } = {}) {
  const { measurements, h, out, phase, safe } = context;
  const result = await page.locator(".conn-settings").evaluate((root) => ({
    url: location.href,
    headings: [...root.querySelectorAll("h1,h2,h3")].map((n) => n.innerText),
    statuses: [...root.querySelectorAll(".status-mark")].map((n) => ({
      label: n.getAttribute("aria-label"),
      tone: [...n.classList]
        .find((c) => c.startsWith("status-mark--"))
        ?.slice(13),
      inHeader: !!n.closest(".conn-settings__head"),
    })),
    overflow: {
      viewport: innerWidth,
      document: document.documentElement.scrollWidth,
    },
    coarse: matchMedia("(pointer:coarse)").matches,
    controls: [...root.querySelectorAll("input,select,button")]
      .filter((n) => n.getClientRects().length)
      .map((n) => {
        const r = n.getBoundingClientRect();
        return {
          label:
            n.labels?.[0]?.textContent?.trim() ??
            n.getAttribute("aria-label") ??
            n.textContent,
          tag: n.tagName,
          type: n.type,
          disabled: n.disabled,
          x: r.x,
          y: r.y,
          width: r.width,
          height: r.height,
        };
      }),
  }));
  measurements.push({ width, height: 900, step, ...result });
  h.check(
    result.overflow.viewport === result.overflow.document,
    `${width} ${step}: zero horizontal overflow`,
  );
  h.check(
    result.coarse === (width === 390),
    `${width} ${step}: actual desktop/touch pointer mode`,
  );
  if (picture) {
    await page.screenshot({
      path: path.join(out, "raw", phase, `${width}-${step}.png`),
      fullPage: false,
    });
    fs.writeFileSync(
      path.join(out, "raw", phase, `${width}-${step}.txt`),
      `${safe(await page.locator(".conn-settings").innerText())}\n`,
    );
  }
  return result;
}
async function showHeader(context, page, width) {
  const { expect } = context;
  await page.evaluate(() => scrollTo(0, 0));
  const marker = page.locator(".conn-settings__head .status-mark").first();
  if (await marker.count()) {
    if (width === 390) await marker.tap();
    else await marker.click();
    await expect(page.locator(".status-bubble")).toHaveText(
      await marker.getAttribute("aria-label"),
    );
  }
}
function closedCount(context, width) {
  return context.workers.filter((w) => w.width === width && w.closed).length;
}
async function expectOff(context, page, panel, width, step) {
  const { expect, h } = context;
  await expect(panel.getByRole("img", { name: /^Connected: / })).toHaveCount(0);
  h.check(
    (await page.locator(".conn-settings__head .status-mark--ok").count()) === 0,
    `${width} ${step}: general header cannot remain connected`,
  );
}
async function connect(context, panel, width) {
  const { fixture, expect, h } = context;
  const oldPeers = fixture.peer.length;
  await panel
    .getByRole("button", { name: "Connect browser node", exact: true })
    .click();
  await panel
    .getByRole("img", { name: /^Connected: / })
    .waitFor({ timeout: 90000 });
  await expect(
    panel.getByLabel("Optional node auth key", { exact: true }),
  ).toHaveValue("");
  h.check(
    fixture.peer.length === oldPeers,
    `${width}: authenticated node membership exists before a service GET`,
  );
}
async function probe(context, panel, width) {
  const { fixture, h } = context;
  const before = fixture.peer.length;
  await panel
    .getByLabel("Tailnet service URL", { exact: true })
    .fill(fixture.peerUrl);
  await panel
    .getByRole("button", { name: "Test tailnet service", exact: true })
    .click();
  const size = JSON.stringify({
    source: "real-native-tailscale-peer",
    nonce: fixture.nonce,
    path: "/proof",
  }).length;
  await panel
    .getByRole("img", {
      name: `HTTP 200 · ${size} characters received through Tailscale`,
      exact: true,
    })
    .waitFor({ timeout: 45000 });
  h.check(
    fixture.peer
      .slice(before)
      .some((r) => r.method === "GET" && r.path === "/proof"),
    `${width}: actual native peer received SDK GET and expected proof response size returned`,
  );
}

async function navigateHome(context, page, width) {
  const { visitBackendRoute, base } = context;
  // Settings backs to Settings; the generic ceremony has the real Connections-home link.
  await visitBackendRoute(page, base, "connections/tailscale");
  await page.locator(".conn-back").waitFor();
  const backHref = await page.locator(".conn-back").getAttribute("href");
  await page.locator(".conn-back").click();
  await page
    .getByRole("heading", { name: "Connections", exact: true })
    .waitFor();
  await page.locator("#connected").waitFor();
  if (width === 1280) {
    const root = page.getByRole("treeitem", {
      name: "Connections",
      exact: true,
    });
    if ((await root.getAttribute("aria-expanded")) !== "true")
      await root.click();
    const branch = page
      .locator("#connections-tree")
      .getByRole("treeitem", { name: "Connected", exact: true });
    if ((await branch.getAttribute("aria-expanded")) !== "true")
      await branch.click();
  }
  return backHref;
}

async function readHome(page, hostname, backHref) {
  return page.evaluate(
    ({ hostname, backHref }) => ({
      url: location.href,
      backHref,
      overflow: {
        viewport: innerWidth,
        document: document.documentElement.scrollWidth,
      },
      rows: [
        ...document.querySelectorAll(
          "#connected .conn-service,#attention .conn-service",
        ),
      ].map((n) => ({
        group: n.closest("section").id,
        id: n.id,
        text: n.innerText,
        statuses: [...n.querySelectorAll(".status-mark")].map((m) => ({
          label: m.getAttribute("aria-label"),
          tone: [...m.classList]
            .find((c) => c.startsWith("status-mark--"))
            ?.slice(13),
        })),
        isCurrentNode: n.querySelector("h3")?.innerText === hostname,
      })),
      rail: [
        ...document.querySelectorAll("#connections-tree [role=treeitem]"),
      ].map((n) => ({
        label: n.getAttribute("aria-label"),
        text: n.innerText,
        href: n.getAttribute("href"),
        expanded: n.getAttribute("aria-expanded"),
        visible: !!n.getClientRects().length,
        count: n.querySelector(".railtree__count")?.innerText ?? null,
      })),
      pageIndex: [...document.querySelectorAll(".page-index a")].map((n) => ({
        text: n.innerText,
        href: n.getAttribute("href"),
        visible: !!n.getClientRects().length,
      })),
    }),
    { hostname, backHref },
  );
}

function assertHome(
  context,
  result,
  { width, stage, live, hostname, oldClosed },
) {
  const { h, phase } = context;
  h.check(
    result.overflow.viewport === result.overflow.document,
    `${width} home ${stage}: zero horizontal overflow`,
  );
  if (live)
    h.check(
      closedCount(context, width) === oldClosed,
      `${width}: ordinary detail/home navigation keeps real node worker running`,
    );
  if (phase === "after" && width === 1280) {
    const branch = result.rail.find((r) => r.label === "Connected");
    h.check(
      branch?.count === (live ? "1" : "-"),
      `${width} home ${stage}: Connected rail count matches live membership`,
    );
    h.check(
      result.rail.some((r) => r.label === hostname && r.visible) === live,
      `${width} home ${stage}: current browser node rail leaf matches live membership`,
    );
  }
  if (phase === "after")
    h.check(
      result.rows.filter((r) => r.group === "connected" && r.isCurrentNode)
        .length === (live ? 1 : 0),
      `${width} home ${stage}: current browser node live membership matches connected list`,
    );
}

async function saveHome(context, page, width) {
  const { out, phase, safe } = context;
  await page.evaluate(() => scrollTo(0, 0));
  await page.screenshot({
    path: path.join(out, "raw", phase, `${width}-home-connected.png`),
    fullPage: false,
  });
  fs.writeFileSync(
    path.join(out, "raw", phase, `${width}-home-connected.txt`),
    `${safe(await page.locator(".section__inner").innerText())}\n`,
  );
}

async function returnToNode(context, page, hostname, live) {
  const { visitBackendRoute, base } = context;
  // Use the actual rendered settings/details link when the current node is listed; baseline may omit it.
  const listed = page
    .locator("#connected .conn-service,#attention .conn-service")
    .filter({
      has: page.getByRole("heading", { name: hostname, exact: true }),
    });
  const details = listed.getByRole("link").first();
  if (await details.count()) await details.click();
  else await visitBackendRoute(page, base, "connections/tailscale");
  const panel = page.getByRole("region", {
    name: "Tailscale browser node",
    exact: true,
  });
  await panel.waitFor();
  if (live) await panel.getByRole("img", { name: /^Connected: / }).waitFor();
  return panel;
}

async function observeHome(context, page, width, stage, live) {
  const { expect, phase, homeMeasurements } = context;
  const oldClosed = closedCount(context, width);
  const hostname = `openss-status-${width}`;
  const backHref = await navigateHome(context, page, width);
  const node = page.locator("#connected .conn-service").filter({
    has: page.getByRole("heading", { name: hostname, exact: true }),
  });
  if (phase === "after") {
    await expect(node).toHaveCount(live ? 1 : 0);
    await expect(node.locator(".status-mark--ok")).toHaveCount(live ? 1 : 0);
  }
  const result = await readHome(page, hostname, backHref);
  homeMeasurements.push({ width, stage, expectedLive: live, ...result });
  assertHome(context, result, { width, stage, live, hostname, oldClosed });
  if (live) await saveHome(context, page, width);
  return returnToNode(context, page, hostname, live);
}

export function createJourney(context) {
  return {
    openNode: openNode.bind(null, context),
    capture: capture.bind(null, context),
    showHeader: showHeader.bind(null, context),
    closedCount: closedCount.bind(null, context),
    expectOff: expectOff.bind(null, context),
    connect: connect.bind(null, context),
    probe: probe.bind(null, context),
    observeHome: observeHome.bind(null, context),
  };
}
