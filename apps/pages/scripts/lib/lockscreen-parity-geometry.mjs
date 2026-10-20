/** Geometry read from the production gate, never a staged reference. */
export function lockscreenGeometry() {
  const box = (selector) => {
    const node = document.querySelector(selector);
    if (!node || !node.getClientRects().length) return null;
    const r = node.getBoundingClientRect();
    return {
      x: r.x,
      y: r.y,
      width: r.width,
      height: r.height,
      right: r.right,
      bottom: r.bottom,
    };
  };
  const firstRing = document.querySelector(".cipher-dial__ring");
  const dial = document.querySelector(".cipher-dial");
  const notes = document.querySelector(".unlock__notes");
  const summaries = [...document.querySelectorAll(".unlock__notes-summary")];
  const first = firstRing instanceof HTMLCanvasElement ? firstRing : null;
  const pane = document.querySelector(".unlock");
  return {
    viewport: { width: innerWidth, height: innerHeight },
    scrollWidth: document.documentElement.scrollWidth,
    pane: box(".unlock"),
    card: box(".unlock__card"),
    heading: box(".unlock__heading"),
    form: box(".unlock__form"),
    hero: box(".unlock__hero"),
    notes: box(".unlock__notes"),
    notesTitle: box(".unlock__notes-title"),
    summary: box(".unlock__notes-summary"),
    input: box(".unlock__form input"),
    ringCenter: first
      ? {
          x:
            Number.parseFloat(first.style.left) +
            Number.parseFloat(first.style.width) / 2,
          y:
            Number.parseFloat(first.style.top) +
            Number.parseFloat(first.style.height) / 2,
        }
      : null,
    ringCount: document.querySelectorAll(".cipher-dial__ring").length,
    mask: getComputedStyle(document.querySelector(".cipher-dial__rings"))
      .maskImage,
    overlayZ: getComputedStyle(document.querySelector(".cipher-dial__overlay"))
      .zIndex,
    dialOpacity: dial
      ? getComputedStyle(dial)
          .getPropertyValue("--cipher-dial-ink-opacity")
          .trim()
      : null,
    notesBackground: notes ? getComputedStyle(notes).backgroundColor : null,
    paneBackground: pane ? getComputedStyle(pane).backgroundImage : null,
    gridRows: pane ? getComputedStyle(pane).gridTemplateRows : null,
    gridAutoRows: pane ? getComputedStyle(pane).gridAutoRows : null,
    releases: summaries.map((node) => ({
      text: node.textContent.trim(),
      expanded: node.getAttribute("aria-expanded"),
    })),
    reduced: matchMedia("(prefers-reduced-motion: reduce)").matches,
  };
}

function checkWide(geometry, check) {
  const { viewport: v, notes, hero, ringCenter, card } = geometry;
  check(
    notes && Math.abs(notes.x - v.width / 2) <= 1,
    "release notes begin at the 50/50 divider",
  );
  check(
    notes && Math.abs(notes.width - v.width / 2) <= 1,
    "release notes fill the right half",
  );
  check(
    hero && notes && hero.right <= notes.x - 24,
    "hero stays inside the left pane",
  );
  check(
    ringCenter && Math.abs(ringCenter.x - v.width / 2) <= 2,
    "dial is centered on the divider",
  );
  check(
    ringCenter && Math.abs(ringCenter.y - v.height * 0.493) <= 3,
    "dial vertical center follows the reference",
  );
  check(
    card && card.width >= 320 && card.width <= 353,
    "credential card keeps its readable 352px measure",
  );
  if (v.width === 1663 && v.height === 946) checkReference(geometry, check);
}

function checkReference(geometry, check) {
  const { hero, card } = geometry;
  check(
    hero &&
      Math.abs(hero.x - 80) <= 6 &&
      Math.abs(hero.y - 150) <= 12 &&
      Math.abs(hero.width - 700) <= 30,
    "reference-size hero matches x80/y150/about700px",
  );
  check(
    card && Math.abs(card.x - 293) <= 12,
    "reference-size card starts around x293",
  );
  check(
    geometry.heading && Math.abs(geometry.heading.y - 368) <= 12,
    "reference-size heading starts around y368",
  );
  check(
    geometry.notesTitle &&
      Math.abs(geometry.notesTitle.x - 884) <= 14 &&
      Math.abs(geometry.notesTitle.y - 116) <= 14,
    "reference-size Release Notes heading matches x884/y116",
  );
}

/** The desktop target adapts without horizontal clipping at narrower sizes. */
export function checkLockscreenGeometry(geometry, check) {
  const v = geometry.viewport;
  check(
    geometry.scrollWidth <= v.width + 1,
    "the document fits the viewport width",
  );
  check(
    geometry.hero &&
      geometry.hero.x >= -1 &&
      geometry.hero.right <= v.width + 1,
    "hero remains within the viewport",
  );
  check(
    geometry.card &&
      geometry.card.x >= -1 &&
      geometry.card.right <= v.width + 1,
    "credential card remains within the viewport",
  );
  check(
    geometry.input &&
      geometry.input.width >= 180 &&
      geometry.input.right <= v.width + 1,
    "credential field stays usable and unclipped",
  );
  check(geometry.ringCount === 11, "all eleven cipher rings remain mounted");
  check(
    geometry.releases.some((release) => release.text.includes("Latest")),
    "newest release is marked Latest",
  );
  if (v.width >= 1100) checkWide(geometry, check);
  else {
    check(
      geometry.notes &&
        geometry.card &&
        geometry.notes.y >= geometry.card.bottom + 12,
      "stacked release notes stay below the complete credential card",
    );
    check(
      geometry.notes &&
        geometry.notes.x >= -1 &&
        geometry.notes.right <= v.width + 1,
      "stacked release notes remain within the viewport",
    );
  }
}
