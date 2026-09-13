/**
 * Before/after sheets, composed in the browser.
 *
 * A reviewer should not have to run the app to see what a UI change did. This
 * takes two directories of same-named captures — one from the base build, one
 * from the branch — and lays each pair side by side with the measurement that
 * makes the difference a fact rather than an impression.
 *
 * Composed in Chromium rather than with an image library because the sheets
 * need type: the labels, the caption and the phone frames are the point, and
 * this repository ships no raster toolchain.
 */

import fs from "node:fs";
import path from "node:path";

/** The sheet's own styling — the product's ink, hairlines and mono voice. */
const SHEET_CSS = `
  * { box-sizing: border-box; }
  body {
    margin: 0;
    padding: 28px 28px 24px;
    background: #fafafa;
    color: #171717;
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    width: max-content;
  }
  h1 { margin: 0 0 2px; font-size: 17px; font-weight: 600; letter-spacing: -0.01em; }
  .caption {
    margin: 0 0 20px;
    max-width: 78ch;
    font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
    font-size: 13.5px;
    line-height: 1.55;
    color: #5c5c5c;
    text-wrap: pretty;
  }
  .pair { display: flex; gap: 22px; align-items: flex-start; }
  figure { margin: 0; display: grid; gap: 8px; justify-items: start; }
  figcaption {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    font-size: 11.5px;
    font-weight: 600;
    letter-spacing: 0.02em;
    text-transform: uppercase;
    color: #5c5c5c;
  }
  figcaption::before {
    content: "";
    width: 9px;
    height: 9px;
    border-radius: 50%;
    background: #b32424;
  }
  figure.is-after figcaption::before { background: #0f7a51; }
  figcaption .m { text-transform: none; letter-spacing: 0; color: #6f6f6f; font-weight: 500; }
  img { display: block; border: 1px solid #d4d4d4; background: #fff; }
`;

/** One pair, sized so both phones render at their own CSS width. */
function figure(side, file, width, note) {
  const data = fs.readFileSync(file).toString("base64");
  return `
    <figure class="${side === "after" ? "is-after" : ""}">
      <figcaption>${side}${note ? ` <span class="m">${note}</span>` : ""}</figcaption>
      <img src="data:image/png;base64,${data}" style="width:${width}px" alt="${side}">
    </figure>`;
}

/**
 * Render one comparison sheet.
 *
 * `shot` names a file present in both directories; `width` is the capture's
 * CSS width so the sheet shows a phone at phone size.
 */
export async function composeSheet(browser, spec, dirs, out) {
  const { shot, width, title, caption, before = "", after = "" } = spec;
  const html = `<!doctype html><meta charset="utf-8"><style>${SHEET_CSS}</style>
    <h1>${title}</h1>
    <p class="caption">${caption}</p>
    <div class="pair">
      ${figure("before", path.join(dirs.before, `${shot}.png`), width, before)}
      ${figure("after", path.join(dirs.after, `${shot}.png`), width, after)}
    </div>`;
  const page = await browser.newPage({ deviceScaleFactor: 2 });
  await page.setContent(html, { waitUntil: "load" });
  await page.waitForTimeout(150);
  const file = path.join(out, `${shot}.png`);
  await page.locator("body").screenshot({ path: file });
  await page.close();
  return file;
}
