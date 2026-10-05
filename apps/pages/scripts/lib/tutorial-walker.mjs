/**
 * How one tutorial is walked, shared by the shell pass and the gate pass of
 * `verify-tutorials.mjs` (ADR 0163 §5, ADR 0166): started from the Support
 * sheet's library, taken through with Next alone (mouse on one step, keyboard
 * on the next), then Back, Replay and Done with focus checked on the way out.
 *
 * It does not know which screen it is on. The shell pass resets to the vault
 * before each tutorial; a gate has no vault to return to, so its pass leaves
 * `reset` off and stands each tutorial on the screen it was listed from.
 */

import {
  advancedFrom,
  reachedStep,
  readStep,
  resetToVault,
  startTutorial,
  tutorialDialog,
  unlockIfLocked,
  walkSteps,
} from "./tutorial-walk.mjs";

/** Back goes back, and Replay begins again; then Done, and where focus went. */
async function finishTour(ctx, page, id, phone, total, shot) {
  const { check, out } = ctx;
  await page.getByRole("button", { name: "Replay" }).click();
  const first = await readStep(page);
  check(
    Boolean(first) && first.step === 1 && first.kind !== "close",
    `${id}: Replay returns to the first step`,
  );
  const again = await walkSteps(page, {
    id: `${id} (replay)`,
    check,
    phone,
    total,
    press: "keyboard",
  });
  check(
    again.at(-1)?.kind === "close",
    `${id}: the replay reaches the closing card again`,
  );
  if (shot) await page.screenshot({ path: `${out}/${shot}-close.png` });
  await page.getByRole("button", { name: "Done" }).click();
  await tutorialDialog(page)
    .waitFor({ state: "detached", timeout: 5000 })
    .catch(() => {});
  check(
    (await tutorialDialog(page).count()) === 0,
    `${id}: Done closes the tutorial`,
  );
  const focus = await page.evaluate(
    () => document.activeElement?.tagName ?? "none",
  );
  check(
    focus !== "BODY" && focus !== "none",
    `${id}: focus is handed back, not dropped on the page (${focus})`,
  );
}

/** A one-step tutorial goes straight to its close, which offers Replay where a step offers Back. */
async function replayOnlyStep(ctx, page, id, first) {
  const { check } = ctx;
  await page.getByRole("button", { name: "Replay" }).click();
  check(
    await reachedStep(page, first.step),
    `${id}: Replay leaves the closing card`,
  );
  const again = await readStep(page);
  check(again?.step === first.step, `${id}: Replay returns to the first step`);
}

/** Forward one step, then Back, so the first step is walked again from its start. */
async function backAndForth(ctx, page, id, first) {
  const { check } = ctx;
  if (first.kind === "close") return;
  await page.locator(".coach__btn--go").click();
  check(await advancedFrom(page, first), `${id}: Next leaves the first step`);
  const second = await readStep(page);
  if (!second) return;
  if (second.kind === "close") {
    await replayOnlyStep(ctx, page, id, first);
    return;
  }
  check(
    second.step === first.step + 1,
    `${id}: Next advances exactly one step`,
  );
  check(
    second.backDisabled === false,
    `${id}: Back is available after the first step`,
  );
  await page.getByRole("button", { name: "Back", exact: true }).click();
  check(
    await reachedStep(page, first.step),
    `${id}: Back leaves the second step`,
  );
  const back = await readStep(page);
  check(back?.step === first.step, `${id}: Back returns to the previous step`);
}

/** The card is up and its first step drawn, with the library's step count said true. */
async function openedCard(ctx, page, entry) {
  const { check } = ctx;
  const id = entry.id;
  const card = await startTutorial(page, id);
  check((await card.count()) === 1, `${id}: the tutorial opens its card`);
  const first = await readStep(page);
  check(Boolean(first), `${id}: the first step is drawn`);
  if (!first) return null;
  check(
    first.focusInCard,
    `${id}: focus lands on the card when a tutorial starts`,
  );
  if (first.counter) {
    const total = Number(first.counter.split(" of ")[1]);
    check(
      Number.isFinite(total) && total === entry.steps,
      `${id}: the library said ${entry.steps} steps and the tutorial has ${total}`,
    );
  }
  return first;
}

/** `reset` returns the shell to its first screen; a gate passes `false`. */
async function walkOne(ctx, page, entry, { phone, width, reset = true }) {
  const { check, setWhere, base, out, keepShots } = ctx;
  const id = entry.id;
  setWhere(`${width}px ${id}`);
  if (reset) {
    await resetToVault(page, base);
    await unlockIfLocked(page);
  }
  const first = await openedCard(ctx, page, entry);
  if (!first) return;
  await backAndForth(ctx, page, id, first);
  const shots = keepShots
    ? async (_info, index) =>
        page.screenshot({
          path: `${out}/${width}-${id.replace(/[^a-z0-9]+/gi, "_")}-${index}.png`,
        })
    : null;
  const seen = await walkSteps(page, {
    id,
    check,
    phone,
    total: entry.steps,
    snap: shots,
  });
  const closed = seen.at(-1)?.kind === "close";
  check(closed, `${id}: reaches its closing card with Next alone`);
  if (!closed) {
    await page.keyboard.press("Escape");
    return;
  }
  await finishTour(
    ctx,
    page,
    id,
    phone,
    entry.steps,
    keepShots ? `${width}-${id}` : null,
  );
}

/** One interaction check; a throw is a failure with its cause, never a skip. */
async function guarded(ctx, page, what, run) {
  try {
    await run();
  } catch (error) {
    ctx.check(
      false,
      `${what}: threw — ${String(error.message).split("\n")[0]}`,
    );
    await page.keyboard.press("Escape").catch(() => {});
  }
}

export function createWalker(ctx) {
  return {
    walkOne: (page, entry, options) => walkOne(ctx, page, entry, options),
    guarded: (page, what, run) => guarded(ctx, page, what, run),
  };
}
