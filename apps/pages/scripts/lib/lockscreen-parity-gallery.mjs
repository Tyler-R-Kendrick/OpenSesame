import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isString } from "../../../../scripts/lib/json-boundary.mjs";
import { composeSheet } from "./visual-evidence.mjs";

const SHOTS = [
  ["1663x946-dark", 1663],
  ["1663x946-light", 1663],
  ["1280x900-dark", 1280],
  ["1100x900-dark", 1100],
  ["1024x1366-dark", 1024],
  ["320x568-dark", 320],
  ["390x844-dark", 390],
  ["430x932-dark", 430],
  ["844x390-dark", 844],
  ["568x320-notes-expanded", 568],
];
const rounded = (value) =>
  Number.isFinite(value) ? Math.round(value * 10) / 10 : "absent";
function note(row) {
  const g = row.geometry;
  return `hero x${rounded(g.hero?.x)} y${rounded(g.hero?.y)} w${rounded(g.hero?.width)}; card x${rounded(g.card?.x)} w${rounded(g.card?.width)}; notes x${rounded(g.notes?.x)}, gap from card ${rounded(g.notes?.y - g.card?.bottom)}px; idle overlay ${row.ink.overlay?.inkPixels ?? "absent"} ink pixels`;
}

/** Compose whole-screen captures; raw screenshots stay outside the repository. */
export async function composeLockscreenGallery(browser, raw, output) {
  fs.mkdirSync(output, { recursive: true });
  const before = JSON.parse(
    fs.readFileSync(path.join(raw, "before/measurements.json"), "utf8"),
  );
  const after = JSON.parse(
    fs.readFileSync(path.join(raw, "after/measurements.json"), "utf8"),
  );
  const dirs = {
    before: path.join(raw, "before"),
    after: path.join(raw, "after"),
  };
  const readme = [
    "# Lock screen parity",
    "",
    "Two real default builds: base `a03b3c50` and this change. Each capture follows the same local PIN seal → lock journey, uses the gate’s own theme control, and leaves normal animation running. Screens are complete viewport captures; no elements were hand-placed or hidden for a shot.",
    "",
    "The supplied 1663 × 946 reference sets the desktop geometry. Smaller screens retain the form, release-note accordion and cipher animation with a stacked layout. The reduced-motion and successful-unlock checks use the same production gate.",
    "",
    "## Measurements",
    "",
    "Across every narrow after capture, including expanded notes and live resizes, the minimum clearance below the complete card is 20.0 px. At 568 × 320 with notes expanded, the baseline gap was −411.4 px (overlap); the after gap is 20.0 px.",
    "",
    "| Screen | Before | After |",
    "|---|---|---|",
  ];
  const specifications = [];
  for (const [shot, width] of SHOTS) {
    const b = before.find((row) => row.label === shot);
    const a = after.find((row) => row.label === shot);
    if (!b || !a) throw new Error(`Missing matching measurement for ${shot}`);
    const spec = {
      shot,
      width,
      title: `Lock screen — ${shot}`,
      caption: shot.includes("notes-expanded")
        ? "Real expanded release notes: the corrected stacked grid keeps the form and notes from overlapping."
        : "Same real PIN-seal and lock journey on two builds. Normal animation remains active; this is a settled idle frame.",
      before: note(b),
      after: note(a),
    };
    if (shot === "390x844-dark") {
      const expanded = "390x844-notes-expanded";
      spec.rows = [
        {
          shot,
          heading: "Collapsed release notes",
          before: note(b),
          after: note(a),
        },
        {
          shot: expanded,
          heading: "Expanded release notes",
          before: note(before.find((row) => row.label === expanded)),
          after: note(after.find((row) => row.label === expanded)),
        },
      ];
    }
    await composeSheet(browser, spec, dirs, output);
    specifications.push(spec);
    readme.push(`| ${shot} | ${note(b)} | ${note(a)} |`);
  }
  finishReadme(readme);
  fs.writeFileSync(path.join(output, "README.md"), readme.join("\n"));
  persistGalleryData(raw, output, specifications);
}

function finishReadme(readme) {
  readme.push(
    "",
    "## Animation and readability proof",
    "",
    "The browser reads real ring-canvas and hero-canvas pixel hashes over time. Normal idle frames must change. Freshly mounted reduced-motion gates must keep all eleven desktop ring canvases painted and static, with a static hero, including after a live resize. Narrow corner dials use aggregate visible glyph ink because some rings fall outside the visible pane. A real PIN submission must advance several door positions and finish at the unlocked vault.",
    "",
    "Canvas alpha measurements require no idle foreground readout/index ink. For desktop, a decoded screenshot also measures the composite contrast of the empty upper cipher arc against its pane background. The fixed bezel must paint at the actual device pixel ratio, including touch contexts at DPR 3.",
    "",
    "The baseline reduced-motion canvases were blank at seven viewport sizes; the two landscape sizes retained only a small clipped fragment. Baseline 1024 px and 320 px release-note summaries had confirmed pointer obstruction from the form/footer. Baseline captures use real Tab navigation and Enter to continue that journey when pointer access is blocked; the after contract requires pointer access after scrolling the summary into view.",
    "",
    "All measurements are recorded in [before-measurements.json](before-measurements.json) and [after-measurements.json](after-measurements.json). The after contract result is [after-result.json](after-result.json). See [validation](validation.md) for gate results and baseline defects.",
    "",
    "## Gallery",
    "",
  );
  for (const [shot] of SHOTS)
    readme.push(
      `### ${shot}`,
      "",
      `![${shot} before and after](${shot}.png)`,
      "",
    );
  readme.push(
    "## Reproduce",
    "",
    "Build the base and current source separately with the default Pages build, then run:",
    "",
    "```sh",
    "PLAYWRIGHT_CHROMIUM=/path/to/chromium PAGES_VERIFY_DIST=/absolute/before/dist \\",
    "  node apps/pages/scripts/capture-lockscreen-parity.mjs before /tmp/lockscreen-parity",
    "PLAYWRIGHT_CHROMIUM=/path/to/chromium PAGES_VERIFY_DIST=/absolute/after/dist \\",
    "  node apps/pages/scripts/capture-lockscreen-parity.mjs after /tmp/lockscreen-parity",
    "PLAYWRIGHT_CHROMIUM=/path/to/chromium \\",
    "  node apps/pages/scripts/capture-lockscreen-parity-gallery.mjs /tmp/lockscreen-parity work/evidence/lockscreen/pages/browser",
    "```",
    "",
  );
}

function persistGalleryData(raw, output, specifications) {
  const files = [];
  const write = (name, value) => {
    const destination = path.join(output, name);
    fs.writeFileSync(destination, `${JSON.stringify(value, null, 2)}\n`);
    files.push(destination);
  };
  write("journey.json", specifications);
  for (const stage of ["before", "after"]) {
    const rows = JSON.parse(
      fs.readFileSync(path.join(raw, stage, "measurements.json"), "utf8"),
    );
    for (const row of rows) {
      if (!row.geometry || !isString(row.geometry.mask)) continue;
      const mask = row.geometry.mask;
      row.geometry.mask = {
        applied: mask !== "none",
        encodedLength: mask.length,
        sha256: createHash("sha256").update(mask).digest("hex"),
      };
    }
    write(`${stage}-measurements.json`, rows);
  }
  write(
    "after-result.json",
    JSON.parse(fs.readFileSync(path.join(raw, "after/result.json"), "utf8")),
  );
  const biome = fileURLToPath(
    new URL("../../../../node_modules/.bin/biome", import.meta.url),
  );
  execFileSync(biome, ["format", "--write", ...files]);
}
