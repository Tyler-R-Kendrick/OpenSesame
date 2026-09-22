/**
 * Cold-load geometry, not a screenshot: state pips cannot shift icon centers.
 *
 * One strip carries command, support, plane truth and notifications
 * (`Statusline.tsx`), and a phone is not a narrow desktop. With room all of it
 * is drawn: Support with the plane keys and the bell (Host is gone; Pages is
 * complete without it — ADR 0128), and the command cluster beside them. A
 * phone keeps the strip but draws only what a phone wants constantly —
 * Support and the command cluster — while the plane keys and the bell roll
 * into the top bar's one overflow key. DESIGN.md § Touch is the contract: the
 * statusline runs edge to edge with no gutter and one left-aligned row of
 * equal keys, and it may never fold onto a second row.
 *
 * Everything here measures the *visible* controls — counting hidden ones would
 * let either arrangement pass for the other. The keys and the command cluster
 * are checked as separate clusters because they are separate in the DOM and
 * separate in the design: the keys are icon-btns of one box, the command
 * cluster is its own pair of affordances.
 */
export async function checkStatusline(page, check) {
  const original = page.viewportSize();
  // 320 is in the list because that is where a strip with too many keys folds
  // onto a second row. Checking 390 alone never saw it.
  for (const viewport of [
    { width: 1280, height: 800 },
    { width: 390, height: 844 },
    { width: 320, height: 568 },
  ]) {
    await page.setViewportSize(viewport);
    await checkProfileLock(page, check, viewport.width);
    const geometry = await page
      .locator("footer.statusline")
      .evaluate((footer) => {
        const measure = (button) => {
          const box = button.getBoundingClientRect();
          const icon = button.querySelector("svg")?.getBoundingClientRect();
          const css = getComputedStyle(button);
          return {
            left: box.left,
            right: box.right,
            width: box.width,
            height: box.height,
            center: box.y + box.height / 2,
            iconCenter: icon ? icon.y + icon.height / 2 : null,
            background: css.backgroundColor,
            border: css.borderWidth,
            radius: css.borderRadius,
          };
        };
        const visible = [...footer.querySelectorAll("button")].filter(
          (button) => button.getClientRects().length > 0,
        );
        const command = footer.querySelector(".statusline__command");
        const commandSet = new Set(
          command ? [...command.querySelectorAll("button")] : [],
        );
        const keys = visible
          .filter((button) => !commandSet.has(button))
          .map(measure);
        const commandButtons = visible
          .filter((button) => commandSet.has(button))
          .map(measure);
        return {
          keys,
          commandButtons,
          start:
            footer.getBoundingClientRect().left +
            Number.parseFloat(getComputedStyle(footer).paddingLeft),
          supportCount: document.querySelectorAll(
            'button[aria-label="Support"]',
          ).length,
          overflowKey: [...document.querySelectorAll(".topbar__more")].filter(
            (button) => button.getClientRects().length > 0,
          ).length,
          stripVisible: [
            ...document.querySelectorAll("footer.statusline"),
          ].filter((el) => el.getClientRects().length > 0).length,
          planesVisible: [
            ...document.querySelectorAll(".statusline__planes"),
          ].filter((el) => el.getClientRects().length > 0).length,
          footerCount: document.querySelectorAll("footer.statusline").length,
          overflow: document.documentElement.scrollWidth > innerWidth,
        };
      });
    checkArrangement(geometry, viewport.width, check);
  }
  if (original) await page.setViewportSize(original);
}

/** The four keys sit on one line: a strip that folds onto a second row is out. */
function onOneAxis(controls) {
  return controls.every(
    (control) => Math.abs(control.center - controls[0].center) < 0.6,
  );
}

/** A run of controls with no hole between them and nothing pushed past them. */
function contiguous(run) {
  return run.every((control, index) => {
    if (index === 0) return true;
    const gap = control.left - run[index - 1].right;
    return gap >= 0 && gap <= 8;
  });
}

/**
 * The arrangement at one width. On a phone: no plane keys drawn — they are
 * behind one key in the top bar — while Support and the command cluster stay.
 * With room: four keys (Support with the plane keys and the bell) and the
 * command cluster beside them, and everything that must hold of the keys.
 */
function checkArrangement(geometry, width, check) {
  const command = geometry.commandButtons;
  check(
    command.length === 2,
    `the command cluster holds its own two controls at ${width}px`,
  );
  if (width < 900) {
    // Support and the command cluster, and nothing else: the plane keys and
    // the bell roll up into the top bar's one overflow key.
    check(
      geometry.keys.length === 1 && geometry.planesVisible === 0,
      `no plane keys are drawn at ${width}px; they are behind one key`,
    );
    check(
      geometry.overflowKey === 1,
      "the top bar carries the overflow the plane keys rolled up into",
    );
    check(
      onOneAxis([...geometry.keys, ...command]),
      "the strip keeps one row at this width and never folds onto a second",
    );
    check(
      Math.abs(geometry.keys[0].left - geometry.start) < 0.6,
      "the statusline runs edge to edge with no gutter",
    );
    check(
      geometry.supportCount === 1 && geometry.footerCount === 1,
      "one Support control in one statusline on cold load",
    );
    check(!geometry.overflow, "footer does not widen the document");
    return;
  }
  const size = 28;
  check(
    geometry.keys.length === 4,
    `footer has 4 visible keys at ${width}px; Support with the plane keys and the bell`,
  );
  check(
    geometry.overflowKey === 0 && geometry.planesVisible === 1,
    "the plane glyphs are the strip where there is room for them",
  );
  check(
    geometry.keys.every((key) => key.width === size && key.height === size),
    "footer key hit areas match",
  );
  check(
    geometry.keys.every(
      (key) =>
        key.iconCenter !== null && Math.abs(key.center - key.iconCenter) < 0.6,
    ),
    "all footer glyphs are centered despite status pips",
  );
  check(
    geometry.keys.every(
      (key) => Math.abs(key.center - geometry.keys[0].center) < 0.6,
    ),
    "footer keys share one vertical axis",
  );
  check(
    Math.abs(geometry.keys[0].left - geometry.start) < 0.6,
    "the support mark sits at the strip's start",
  );
  check(
    contiguous(geometry.keys.slice(1)),
    "the plane keys and the bell close the row as one contiguous run",
  );
  check(
    new Set(
      geometry.keys.map(
        ({ background, border, radius }) => `${background}/${border}/${radius}`,
      ),
    ).size === 1,
    "footer keys share surface and border styling",
  );
  check(
    geometry.supportCount === 1 && geometry.footerCount === 1,
    "one Support control in one statusline on cold load",
  );
  check(!geometry.overflow, "footer does not widen the document");
}

async function checkProfileLock(page, check, width) {
  const prompt = page.locator(
    width > 900 ? ".rail .rail__prompt" : ".topbar .rail__prompt",
  );
  const lockBox = await prompt
    .getByRole("button", { name: "Lock vault" })
    .boundingBox();
  const vaultBox = await prompt.locator(".project-switcher").boundingBox();
  check(
    (await page.getByRole("button", { name: "Lock vault" }).count()) === 1 &&
      lockBox &&
      vaultBox &&
      lockBox.x >= vaultBox.x + vaultBox.width &&
      lockBox.x - vaultBox.x - vaultBox.width <= 24 &&
      Math.abs(
        lockBox.y + lockBox.height / 2 - vaultBox.y - vaultBox.height / 2,
      ) < 1,
    `one visible lock beside the vault switcher at ${width}px`,
  );
}
