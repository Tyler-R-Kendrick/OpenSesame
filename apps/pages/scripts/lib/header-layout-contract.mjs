/** Read the shipped header's real boxes in the browser. */
export function headerGeometry() {
  const visible = (node) => node && node.getClientRects().length > 0;
  const rect = (node) => {
    if (!visible(node)) return null;
    const box = node.getBoundingClientRect();
    return {
      x: box.x,
      y: box.y,
      right: box.right,
      bottom: box.bottom,
      width: box.width,
      height: box.height,
    };
  };
  const header = document.querySelector(".app-header");
  const account = header?.querySelector(".account-switcher .prompt__seg");
  const vault = header?.querySelector(".project-switcher .prompt__seg");
  const controls = [
    ...(header?.querySelectorAll("button, [data-touch-twin]") ?? []),
  ]
    .filter(
      (node) =>
        visible(node) &&
        !node.closest(
          ".sheet-layer, .drawer, .account-switcher__menu, .project-switcher__menu",
        ),
    )
    .map((node) => ({
      name:
        node.getAttribute("aria-label") ||
        node.getAttribute("title") ||
        node.textContent.trim(),
      ...rect(node),
    }));
  const overlaps = controls.flatMap((control, index) =>
    controls
      .slice(index + 1)
      .filter(
        (other) =>
          Math.min(control.right, other.right) - Math.max(control.x, other.x) >
            0.5 &&
          Math.min(control.bottom, other.bottom) -
            Math.max(control.y, other.y) >
            0.5,
      )
      .map((other) => `${control.name} / ${other.name}`),
  );
  return {
    header: rect(header),
    main: rect(document.querySelector(".main")),
    rail: rect(document.querySelector(".rail")),
    footer: rect(document.querySelector(".statusline")),
    brand: rect(header?.querySelector(".wordmark")),
    tools: rect(header?.querySelector(".app-header__tools")),
    glyphs: [...(header?.querySelectorAll(".prompt__glyph") ?? [])]
      .map(rect)
      .filter(Boolean),
    vault: rect(vault),
    account: rect(account),
    punctuation: [...(header?.querySelectorAll(".prompt__dim") ?? [])]
      .filter(visible)
      .map((node) => ({ text: node.textContent.trim(), ...rect(node) })),
    bell: rect(header?.querySelector('button[aria-label^="Notifications —"]')),
    install: rect(
      header?.querySelector('button[aria-label="Install OpenSesame"]'),
    ),
    headerCount: document.querySelectorAll(".app-header").length,
    accountCount: document.querySelectorAll(".account-switcher").length,
    vaultCount: document.querySelectorAll(".project-switcher").length,
    lockCount: document.querySelectorAll('button[aria-label="Lock vault"]')
      .length,
    bellCount: document.querySelectorAll(
      'button[aria-label^="Notifications —"]',
    ).length,
    coarse: matchMedia("(pointer: coarse)").matches,
    width: innerWidth,
    height: innerHeight,
    scrollWidth: document.documentElement.scrollWidth,
    controls,
    overlaps,
  };
}

function checkFrame(geometry, check) {
  const h = geometry.header;
  check(
    geometry.headerCount === 1 &&
      h &&
      Math.abs(h.y) < 0.5 &&
      Math.abs(h.x) < 0.5 &&
      Math.abs(h.width - geometry.width) < 1,
    "one header spans the viewport at the absolute top",
  );
  if (!h) return;
  check(
    geometry.main && Math.abs(geometry.main.y - h.bottom) < 1,
    "main content starts below the header",
  );
  if (geometry.rail)
    check(
      Math.abs(geometry.rail.y - h.bottom) < 1,
      "sidebar starts below the header",
    );
  check(
    geometry.footer && Math.abs(geometry.footer.bottom - geometry.height) < 1,
    "command bar stays at the viewport bottom",
  );
  check(
    geometry.scrollWidth <= geometry.width + 1,
    "document never widens past the viewport",
  );
}

function checkControls(geometry, check) {
  const h = geometry.header;
  check(
    geometry.accountCount === 1 &&
      geometry.vaultCount === 1 &&
      geometry.lockCount === 1 &&
      geometry.bellCount === 1,
    "identity, lock and notification controls each mount once",
  );
  check(
    geometry.overlaps.length === 0,
    `header hit targets do not overlap (${geometry.overlaps.join(", ")})`,
  );
  check(
    geometry.controls.every(
      (key) =>
        key.x >= h.x - 0.5 &&
        key.right <= h.right + 0.5 &&
        key.y >= h.y - 0.5 &&
        key.bottom <= h.bottom + 0.5,
    ),
    "every header key remains fully inside the header",
  );
  if (geometry.coarse || geometry.width <= 900) {
    check(
      geometry.controls.every((key) => key.width >= 43.5 && key.height >= 43.5),
      "all header controls retain 44px touch targets",
    );
  }
  check(
    geometry.main && geometry.main.height >= Math.min(200, geometry.height / 2),
    "chrome leaves usable content height",
  );
}

function checkIdentity(geometry, check) {
  check(
    (geometry.brand || (geometry.width <= 900 && geometry.height <= 500)) &&
      geometry.vault &&
      geometry.account &&
      geometry.bell,
    "brand, both identity switchers and notifications remain visible",
  );
  check(
    geometry.vault &&
      geometry.account &&
      geometry.vault.right <= geometry.account.x + 1,
    "vault name precedes account name",
  );
  const at = geometry.punctuation.find((mark) => mark.text === "@");
  check(
    at &&
      geometry.vault &&
      geometry.account &&
      at.x >= geometry.vault.right - 1 &&
      at.right <= geometry.account.x + 1,
    "@ is between vault and account, before the username",
  );
}

function checkGlyphs(geometry, check) {
  check(geometry.glyphs.length === 2, "both identity glyphs are visible");
  if (geometry.glyphs.length === 2 && geometry.vault) {
    const [first, second] = geometry.glyphs.toSorted((a, b) => a.x - b.x);
    check(
      first.right <= second.x + 1 &&
        second.x - first.right <= 12 &&
        second.right <= geometry.vault.x + 1,
      "identity glyphs sit together before both names",
    );
  }
}

function checkDesktop(geometry, check) {
  const h = geometry.header;
  if (geometry.width > 900) {
    check(h.height <= 72, "desktop uses a single compact title row");
    check(
      geometry.bell && h.right - geometry.bell.right <= 32,
      "notifications close the far right of the bar",
    );
    if (geometry.install)
      check(
        geometry.install.right <= geometry.bell.x &&
          geometry.bell.x - geometry.install.right <= 32,
        "install sits immediately beside notifications",
      );
  }
}

/** Optional status keys must not grow underneath the brand on the same row. */
function checkBrandSpace(geometry, check) {
  const { brand, tools } = geometry;
  if (!brand || !tools) return;
  const horizontal =
    Math.min(brand.right, tools.right) - Math.max(brand.x, tools.x);
  const vertical =
    Math.min(brand.bottom, tools.bottom) - Math.max(brand.y, tools.y);
  check(
    horizontal <= 0.5 || vertical <= 0.5,
    "brand and utility controls never overlap on their shared row",
  );
}

/** Separate assertions keep a failed layout readable in the evidence log. */
export function checkHeaderGeometry(geometry, check) {
  checkFrame(geometry, check);
  if (!geometry.header) return;
  checkControls(geometry, check);
  checkIdentity(geometry, check);
  checkGlyphs(geometry, check);
  checkDesktop(geometry, check);
  checkBrandSpace(geometry, check);
}
