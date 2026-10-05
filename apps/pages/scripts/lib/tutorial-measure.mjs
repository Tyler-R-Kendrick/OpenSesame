/**
 * What one tutorial step shows, measured in the page, and what every step owes.
 *
 * A step that points at a control is only a pass if the control the registry
 * names is lit, on screen, not covered by the card, and is what a pointer
 * actually reaches through the aperture. The control is found by its registry
 * target id (`data-guide-targets`, set where the registry binds it), never by
 * the ring the product drew: the ring is the claim, the control is the fact.
 */

/**
 * Runs in the page: everything one step shows. Small helpers, so the
 * measurement stays readable and each one is simple to trust.
 */
export function measureStep() {
  const root = document.querySelector(".coach");
  if (!root) return null;
  const text = (selector) => root.querySelector(selector)?.textContent ?? "";
  const box = (node) => {
    if (!node) return null;
    const { left, top, right, bottom, width, height } =
      node.getBoundingClientRect();
    return { left, top, right, bottom, width, height };
  };
  const pointable = (element) => {
    for (let node = element; node; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (style.display === "none" || style.visibility === "hidden")
        return false;
    }
    return true;
  };
  const describe = (node) => {
    if (!node) return "nothing";
    const id = node.id ? `#${node.id}` : "";
    const first = String(node.getAttribute("class") ?? "").split(" ")[0];
    return `${node.tagName.toLowerCase()}${id}${first ? `.${first}` : ""}`;
  };
  const viewport = {
    width: document.documentElement.clientWidth,
    height: innerHeight,
  };
  // The part of the control a person could press: its box inside the screen
  // and inside the aperture the product opened for it.
  const visiblePart = (control, ring) => {
    const parts = [
      box(control),
      { left: 0, top: 0, right: viewport.width, bottom: viewport.height },
    ];
    if (ring) parts.push(ring);
    const left = Math.max(...parts.map((part) => part.left));
    const top = Math.max(...parts.map((part) => part.top));
    const right = Math.min(...parts.map((part) => part.right));
    const bottom = Math.min(...parts.map((part) => part.bottom));
    return right > left && bottom > top ? { left, top, right, bottom } : null;
  };
  const probeControl = (control, ring) => {
    const part = visiblePart(control, ring);
    if (!part) return { visible: false };
    const x = (part.left + part.right) / 2;
    const y = (part.top + part.bottom) / 2;
    const hit = document.elementFromPoint(x, y);
    return {
      visible: true,
      x: Math.round(x),
      y: Math.round(y),
      hit: describe(hit),
      onControl: Boolean(hit) && control.contains(hit),
      onCard: Boolean(hit?.closest(".coach__card")),
      onDim: Boolean(hit?.classList.contains("coach__dim")),
    };
  };
  const target = root.getAttribute("data-coach-target") ?? "";
  const control = target
    ? ([...document.querySelectorAll(`[data-guide-targets~="${target}"]`)].find(
        pointable,
      ) ?? null)
    : null;
  const card = root.querySelector(".coach__card");
  const ring = root.querySelector(".coach__ring");
  const go = root.querySelector(".coach__btn--go");
  const back = [...root.querySelectorAll(".coach__btn")].find((b) =>
    /Back|Replay/.test(b.textContent ?? ""),
  );
  const ringBox = box(ring);
  return {
    kind: root.getAttribute("data-coach-kind"),
    step: Number(root.getAttribute("data-coach-step")),
    target,
    degraded: root.getAttribute("data-coach-degraded") === "true",
    counter: text(".coach__count"),
    title: text(".coach__title"),
    text: text(".coach__text"),
    cue: text(".coach__cue"),
    notOnScreen: text(".coach__cue").includes("not on screen"),
    action: Boolean(ring?.classList.contains("is-action")),
    card: box(card),
    ring: ringBox,
    control: box(control),
    probe: control ? probeControl(control, ringBox) : null,
    go: box(go),
    goDisabled: go ? go.disabled : null,
    backDisabled: back ? back.disabled : null,
    focusInCard: Boolean(card?.contains(document.activeElement)),
    viewport,
  };
}

function intersects(a, b) {
  return (
    a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top
  );
}

const inside = (box, viewport) =>
  box.left >= -0.5 &&
  box.top >= -0.5 &&
  box.right <= viewport.width + 0.5 &&
  box.bottom <= viewport.height + 0.5;

const touches = (box, viewport) =>
  box.width > 0 &&
  box.height > 0 &&
  box.right > 0 &&
  box.bottom > 0 &&
  box.left < viewport.width &&
  box.top < viewport.height;

const describeBox = (box) =>
  `${Math.round(box.left)},${Math.round(box.top)} ${Math.round(box.width)}x${Math.round(box.height)}`;

/** The card, and Next on it. */
function cardChecks(info, phone) {
  const { card, go, viewport } = info;
  const out = [
    [
      inside(card, viewport),
      `the card sits inside the viewport (${describeBox(card)} in ${viewport.width}x${viewport.height})`,
    ],
    [
      Boolean(go) && go.width > 0 && !info.goDisabled,
      "Next is present and enabled",
    ],
    [info.text.trim().length > 0, "the step says something"],
  ];
  if (!go) return out;
  out.push([inside(go, viewport), "Next is inside the viewport"]);
  if (phone) {
    out.push([
      go.height >= 43.5,
      `Next is a 44px key on a phone (${Math.round(go.height)}px)`,
    ]);
  }
  return out;
}

/** What a pointer reaches at the visible centre of the control, as one check. */
function reachChecks(info) {
  const { probe, target } = info;
  if (probe === null) {
    return [[false, `the registry's control for ${target} is in the page`]];
  }
  if (!probe.visible) {
    return [
      [
        false,
        `the control for ${target} has a visible part inside the aperture`,
      ],
    ];
  }
  const where = `at ${probe.x},${probe.y} a pointer reaches ${probe.hit}`;
  const cause = probe.onCard ? " (the card)" : probe.onDim ? " (the dim)" : "";
  return [
    [
      probe.onControl,
      `the lit control is reachable through the aperture: ${where}${cause}, not ${target}`,
    ],
  ];
}

/** The lit control: there, visible, uncovered by the card, reachable. */
function litChecks(info) {
  const { card, ring, viewport } = info;
  const out = [
    [!info.notOnScreen, "the control the step points at is on screen"],
  ];
  if (info.notOnScreen) return out;
  out.push([Boolean(ring), "the lit control has an aperture around it"]);
  if (!ring) return out;
  out.push(
    [touches(ring, viewport), "the lit control is inside the viewport"],
    [!intersects(card, ring), "the card does not cover the lit control"],
    ...reachChecks(info),
  );
  return out;
}

/** The checks every step owes, as [ok, what] pairs. */
export function stepChecks(info, { phone }) {
  if (!info.card) return [[false, "the card is on screen"]];
  const out = [[true, "the card is on screen"], ...cardChecks(info, phone)];
  if (info.kind === "point" && info.target !== "") out.push(...litChecks(info));
  return out;
}
