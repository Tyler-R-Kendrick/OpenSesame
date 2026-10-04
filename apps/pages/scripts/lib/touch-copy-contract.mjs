// Keyboard-only copy under a finger (DESIGN.md § Touch).
//
// jsdom loads no stylesheet, so the unit tests prove each twin exists and not
// that the CSS stands the keys voice down. This measures it in the coarse
// context: nothing that names a key is drawn, the gv chord chip is gone, and
// the command bar's placeholder fits its field whole.

/** Evaluated in the page; a string body keeps it out of the bundler. */
export const TOUCH_COPY = `(() => {
  const shown = (el) => {
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return s.display !== "none" && s.visibility !== "hidden" && r.width > 0 && r.height > 0;
  };
  const count = (selector) => [...document.querySelectorAll(selector)].filter(shown).length;
  const input = document.querySelector(".command-bar__input");
  let bar = null;
  if (input && shown(input)) {
    const s = getComputedStyle(input);
    const ctx = document.createElement("canvas").getContext("2d");
    ctx.font = s.font;
    const text = input.getAttribute("placeholder") ?? "";
    const room = input.clientWidth - parseFloat(s.paddingLeft) - parseFloat(s.paddingRight);
    bar = {
      placeholder: text,
      text: Math.ceil(ctx.measureText(text).width),
      room: Math.floor(room),
      scrollWidth: input.scrollWidth,
      clientWidth: input.clientWidth,
    };
  }
  return {
    jump: count(".railtree__jump"),
    keysVoice: count(".empty__tip-keys, .empty__tip--keys, .buffer__keys-keys, .buffer__keys--keys"),
    bar,
  };
})()`;

/** Audit the stop that has just been drawn; `label` names it on a failure. */
export async function touchCopyStop(page, label, harness) {
  const seen = await page.evaluate(TOUCH_COPY);
  harness.check(
    seen.jump === 0,
    `${label}: the gv chip is hidden (saw ${seen.jump})`,
  );
  harness.check(
    seen.keysVoice === 0,
    `${label}: no keys-voice copy is drawn (saw ${seen.keysVoice})`,
  );
  if (seen.bar) {
    const { text, room, scrollWidth, clientWidth, placeholder } = seen.bar;
    harness.check(
      text <= room && scrollWidth <= clientWidth,
      `${label}: the command bar placeholder "${placeholder}" fits (text ${text}px in ${room}px, scrollWidth ${scrollWidth} / clientWidth ${clientWidth})`,
    );
  }
  return seen;
}
