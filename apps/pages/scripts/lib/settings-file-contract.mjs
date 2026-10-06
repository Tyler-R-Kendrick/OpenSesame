/**
 * Settings' file viewer in the touch journey (DESIGN.md § Touch).
 *
 * Neither the phone walk nor the tablet walk used to open a settings file, so
 * a deleted stylesheet block (the list and the open file side by side on a
 * phone, rows under the 44px floor) and a painted editor whose text was set
 * below 16px went unseen: the audit had no screen to measure. This opens the
 * files a provider keeps — a new draft and a read-only built-in — and runs
 * the whole phone audit on each, then states what only the viewer owes: the
 * list above the file where the
 * window is narrow and beside it where it is wide, a 44px row, one size for
 * the painted copy and the textarea over it, and a long line that scrolls the
 * stage and never the page. A page's own document (`config.yaml`, a capability
 * document) is not one of those files: it is drawn as the page, and its stop
 * says so.
 */

const DRAFT = "settings/item-types/installed/new.json";
const BUILTIN = "settings/item-types/builtin/secret.json";

/** An in-app navigation, the way a shared deep link lands; a reload would
 * lock the guest's vault and end the walk. */
async function visit(page, base, route) {
  await page.evaluate((href) => {
    history.pushState(null, "", href);
    dispatchEvent(new PopStateEvent("popstate"));
  }, `${base}${route}`);
  await page.waitForTimeout(1100);
}

const fileRoute = (category, file) =>
  `settings/${category}?file=${encodeURIComponent(file)}`;

/** Everything the viewer's checks read, in one round trip. */
function measureViewer() {
  const box = (el) => {
    const r = el?.getBoundingClientRect();
    return r && { l: r.left, t: r.top, r: r.right, b: r.bottom, w: r.width };
  };
  const drawn = (el) => el.getClientRects().length > 0;
  const list = document.querySelector(".vfiles__list");
  const file = document.querySelector(".vfiles__open");
  const stage = document.querySelector(".set-raw__stage");
  const paint = stage?.querySelector(".set-raw__paint");
  const input = stage?.querySelector(".set-raw__input");
  const rows = [...document.querySelectorAll(".vfiles__file, .vfiles__dirname")]
    .filter(drawn)
    .map((el) => ({
      name: (el.textContent ?? "").trim().slice(0, 30),
      h: el.getBoundingClientRect().height,
    }));
  const size = (el) => Number.parseFloat(getComputedStyle(el).fontSize);
  const doc = document.scrollingElement ?? document.documentElement;
  return {
    narrow: matchMedia("(max-width: 900px)").matches,
    coarse: matchMedia("(pointer: coarse)").matches,
    vw: document.documentElement.clientWidth,
    docWidth: doc.scrollWidth,
    list: box(list),
    file: box(file),
    rows,
    stage: stage && {
      overflowX: getComputedStyle(stage).overflowX,
      scrollWidth: stage.scrollWidth,
      clientWidth: stage.clientWidth,
      scrollLeft: stage.scrollLeft,
    },
    paintSize: paint ? size(paint) : 0,
    inputSize: input ? size(input) : 0,
    paintBox: box(paint),
    inputBox: box(input),
  };
}

const near = (a, b) => Math.abs(a - b) < 1;

/** The stage, the type and the layers over each other: true of every file. */
function editorChecks(harness, label, m) {
  harness.check(
    m.stage !== null && m.stage.overflowX === "auto",
    `${label}: the stage scrolls sideways itself (overflow-x ${m.stage?.overflowX})`,
  );
  harness.check(
    m.docWidth <= m.vw + 1,
    `${label}: a long line never widens the page (${m.docWidth} <= ${m.vw})`,
  );
  const floor = m.coarse || m.narrow ? 16 : 0;
  harness.check(
    m.inputSize >= floor && near(m.inputSize, m.paintSize),
    `${label}: the textarea and its painted copy share one size >= ${floor}px (${m.inputSize} / ${m.paintSize})`,
  );
  const [paint, input] = [m.paintBox, m.inputBox];
  harness.check(
    paint &&
      input &&
      near(paint.l, input.l) &&
      near(paint.t, input.t) &&
      near(paint.w, input.w),
    `${label}: the painted copy lies exactly under the textarea`,
  );
}

/** The list above the file where narrow, beside it where wide. */
function arrangementCheck(harness, label, m) {
  if (m.narrow) {
    harness.check(
      m.list.b <= m.file.t + 0.5 && near(m.list.l, m.file.l),
      `${label}: one column — the list sits above the open file (list bottom ${Math.round(m.list.b)}, file top ${Math.round(m.file.t)})`,
    );
    return;
  }
  harness.check(
    m.list.r <= m.file.l + 0.5,
    `${label}: two columns — the list sits beside the open file (list right ${Math.round(m.list.r)}, file left ${Math.round(m.file.l)})`,
  );
}

/** The viewer's own claims about one open file. */
export function viewerChecks(harness, label, m, { list = true } = {}) {
  harness.setStep(label);
  editorChecks(harness, label, m);
  if (!list) return;
  const listed = m.list !== null && m.file !== null;
  harness.check(
    listed,
    `${label}: the file list and the open file are both drawn`,
  );
  if (!listed) return;
  arrangementCheck(harness, label, m);
  const touch = m.coarse || m.narrow;
  const short = m.rows.filter((row) => row.h + 0.5 < 44);
  const names = short.map((r) => `${r.name} ${Math.round(r.h)}px`).join(", ");
  harness.check(
    m.rows.length > 0 && (short.length === 0 || !touch),
    `${label}: every file and directory row is >= 44px under touch (${m.rows.length} rows${short.length ? `, short: ${names}` : ""})`,
  );
}

/** Open a file, audit it, and say what the viewer owes. */
async function openStop(ctx, name, route, options) {
  const label = ctx.stop(name);
  await visit(ctx.page, ctx.base, route);
  await ctx.audit(ctx.page, label);
  viewerChecks(
    ctx.harness,
    label,
    await ctx.page.evaluate(measureViewer),
    options,
  );
}

/** A person pastes one very long line: the stage scrolls to the caret. */
async function longLine(ctx) {
  const { page, harness } = ctx;
  const label = ctx.stop("file-long-line");
  const field = page.locator(".set-raw__input").first();
  await field.tap();
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.press("Delete");
  await page.keyboard.insertText("x".repeat(300));
  await page.waitForTimeout(500);
  await ctx.audit(page, label);
  const m = await page.evaluate(measureViewer);
  viewerChecks(harness, label, m);
  const room = m.stage.scrollWidth - m.stage.clientWidth;
  harness.check(
    room > 0 && m.docWidth <= m.vw + 1,
    `${label}: 300 characters scroll the stage, not the page (stage ${m.stage.scrollWidth} > ${m.stage.clientWidth}, page ${m.docWidth} <= ${m.vw})`,
  );
  harness.check(
    m.stage.scrollLeft >= room - 2,
    `${label}: the caret at the end of the line is scrolled into view (scrollLeft ${Math.round(m.stage.scrollLeft)} of ${Math.round(room)})`,
  );
}

/** Reach the built-in the way a finger does: its directory, then its row. */
async function openBuiltin(ctx) {
  const { page } = ctx;
  const dir = page.locator("summary.vfiles__dirname", { hasText: "builtin/" });
  if (await dir.count()) {
    const open = await dir.evaluate((el) => el.parentElement?.open === true);
    if (!open) await dir.first().tap();
    await page.waitForTimeout(400);
  }
  await page.locator(".vfiles__file", { hasText: "secret.json" }).first().tap();
  await page.waitForTimeout(900);
}

/**
 * The files, at whatever width the walk is at. `ctx` is `{ page, harness,
 * audit, stop, base }`, the pieces `verify-mobile.mjs` already holds.
 */
export async function settingsFileStops(ctx) {
  await openStop(ctx, "file-draft", fileRoute("vaults", DRAFT));
  await longLine(ctx);
  // The list is real: tap the built-in's directory and its row.
  await ctx.page.waitForTimeout(100);
  const label = ctx.stop("file-builtin");
  await openBuiltin(ctx);
  await ctx.audit(ctx.page, label);
  const open = await ctx.page.evaluate(
    (path) =>
      document.querySelector(`.set-raw__input[aria-label="${path}"]`)?.readOnly,
    BUILTIN,
  );
  ctx.harness.check(
    open === true,
    `${label}: tapping the built-in's row opens it, read-only`,
  );
  viewerChecks(ctx.harness, label, await ctx.page.evaluate(measureViewer));
  await documentStop(
    ctx,
    "file-capabilities",
    fileRoute(
      "capabilities",
      "settings/capabilities/installation-selection.yaml",
    ),
    "[data-testid='capabilities-panel']",
  );
  await documentStop(
    ctx,
    "file-config",
    "settings?file=config.yaml",
    ".set__nav-link[aria-current='page']",
  );
}

/**
 * A page's own document — `config.yaml`, a capability document — is the page,
 * drawn as every page is. The audit runs on it, and it owes no text editor
 * and no file list of its own.
 */
async function documentStop(ctx, name, route, pageSelector) {
  const label = ctx.stop(name);
  await visit(ctx.page, ctx.base, route);
  await ctx.audit(ctx.page, label);
  const drawn = await ctx.page.evaluate(
    (selector) => ({
      page: document.querySelector(selector) !== null,
      editor: document.querySelector(".set-raw__stage") !== null,
      files: document.querySelector(".vfiles") !== null,
    }),
    pageSelector,
  );
  ctx.harness.setStep(label);
  ctx.harness.check(
    drawn.page && !drawn.editor && !drawn.files,
    `${label}: the document is drawn as the page, with no text editor or file list (page ${drawn.page}, editor ${drawn.editor}, files ${drawn.files})`,
  );
}
