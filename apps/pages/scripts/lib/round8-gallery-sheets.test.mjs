import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "vitest";
import {
  dropCaption,
  dropNote,
  dropSheets,
  galleryIntro,
  htmlEscape,
  peerCompareCaption,
  peerCompareNote,
  peerExportNote,
  peerSheets,
  q,
  writeJourney,
  writeReadme,
} from "./round8-gallery-sheets.mjs";

const VIEWS = [
  { id: "1280", width: 1280, height: 900, desktop: true },
  { id: "390", width: 390, height: 844, desktop: false },
];

const WALKS = [
  {
    name: "minimal-local",
    setupChoice: "Minimal",
    capabilityProfile:
      "/repo/apps/pages/capability-profiles/minimal-local.json",
    buildKey: "minimal-local",
    note: "",
  },
  {
    name: "default",
    setupChoice: "Default",
    capabilityProfile: null,
    buildKey: "stock",
    note: "no capability-profiles/default.json; stock build, setup choice Default",
  },
];

function dropMeasure(opensOn) {
  const cell = { any: 1, here: 1, warning: 0, opensOn };
  return { share: cell, ready: { ...cell, warning: 1 } };
}

function peerMeasure(overrides = {}) {
  return {
    fingerprint: "AB CD EF",
    shortAuth: null,
    unavailable: 0,
    qr: 1,
    copy: 1,
    match: 1,
    letIn: 0,
    rowSas: "sas-1",
    joinerSas: "sas-1",
    compareError: "",
    ...overrides,
  };
}

function capturedCell(measure) {
  return { note: "", buildKey: "stock", 1280: measure, 390: measure };
}

function capturedWith(measureOf) {
  const captured = { before: {}, after: {} };
  for (const walk of WALKS) {
    captured.before[walk.name] = capturedCell(measureOf("before"));
    captured.after[walk.name] = capturedCell(measureOf("after"));
  }
  return captured;
}

test("q quotes a value and marks an absent one", () => {
  assert.equal(q("hello"), "“hello”");
  assert.equal(q(""), "absent");
  assert.equal(q(null), "absent");
  assert.equal(q(undefined), "absent");
});

test("htmlEscape escapes markup in captions", () => {
  assert.equal(htmlEscape("<a & b>"), "&lt;a &amp; b&gt;");
});

test("dropNote carries the Opens on row and the counts", () => {
  const note = dropNote({
    any: 2,
    here: 1,
    warning: 0,
    opensOn: "Any browser",
  });
  assert.equal(note, "Opens on “Any browser” · any 2 · this browser 1");
});

test("dropCaption names the place and both sides", () => {
  const view = VIEWS[0];
  const caption = dropCaption(
    "default",
    view,
    dropMeasure("Any browser with the link"),
    dropMeasure("This browser"),
    "ready",
  );
  assert.match(caption, /^Drop ready on default at 1280 × 900\./);
  assert.match(caption, /Before: Opens on is “Any browser with the link”/);
  assert.match(caption, /After: Opens on is “This browser”/);
});

test("peerExportNote prefers the fingerprint and falls back to the SAS label", () => {
  assert.equal(peerExportNote(peerMeasure()), "Fingerprint “AB CD EF” · QR 1");
  assert.equal(
    peerExportNote(peerMeasure({ fingerprint: null, shortAuth: "123-456" })),
    "Short authentication string “123-456” · QR 1",
  );
});

test("peerCompareNote reads the admit control, or the failure", () => {
  assert.equal(
    peerCompareNote(peerMeasure()),
    "Yes, they match 1 · SAS “sas-1”",
  );
  assert.equal(
    peerCompareNote(peerMeasure({ match: 0, letIn: 1 })),
    "Let Ada Lovelace in 1",
  );
  assert.equal(
    peerCompareNote(peerMeasure({ match: 0, letIn: 0, compareError: "boom" })),
    "boom",
  );
  assert.equal(
    peerCompareNote(peerMeasure({ match: 0, letIn: 0 })),
    "admit control absent",
  );
});

test("peerCompareCaption says whether host and joiner share a SAS", () => {
  const shared = peerCompareCaption(
    "full",
    VIEWS[1],
    peerMeasure({ rowSas: "", joinerSas: "" }),
    peerMeasure(),
  );
  assert.match(shared, /show the same SAS\./);
  const split = peerCompareCaption(
    "full",
    VIEWS[1],
    peerMeasure(),
    peerMeasure({ joinerSas: "sas-2", compareError: "late" }),
  );
  assert.match(split, /do not show one shared SAS\./);
  assert.match(split, /Capture note: late/);
});

test("dropSheets lays out one sheet and one screen per profile and view", () => {
  const { sheets, screens } = dropSheets(
    WALKS,
    capturedWith((side) => dropMeasure(side)),
    VIEWS,
  );
  assert.equal(sheets.length, 4);
  assert.equal(screens.length, 4);
  assert.equal(sheets[0].shot, "minimal-local-1280");
  assert.deepEqual(
    sheets[0].rows.map((row) => row.heading),
    ["Share once", "Drop ready"],
  );
  assert.deepEqual(
    screens[1].steps.map((step) => Object.keys(step)[0]),
    ["guest", "visit", "press", "shot", "press", "shot"],
  );
});

test("peerSheets pairs the export and the admit control per sheet", () => {
  const { sheets, screens } = peerSheets(
    WALKS,
    capturedWith(() => peerMeasure()),
    VIEWS,
  );
  assert.equal(sheets.length, 4);
  assert.equal(sheets[3].shot, "default-390");
  assert.deepEqual(
    sheets[3].rows.map((row) => row.shot),
    ["default-390-export", "default-390-compare"],
  );
  assert.equal(screens[0].profile, "minimal-local");
});

test("galleryIntro names the shas, the subject and each profile", () => {
  const intro = galleryIntro("p8-1", "before-sha", "after-sha", WALKS);
  assert.match(intro, /Before `before-sha`\. After `after-sha`\./);
  assert.match(intro, /verify-portable-drop\.mjs/);
  assert.match(
    intro,
    /`minimal-local` \(Minimal\): capability profile minimal-local\.json/,
  );
  assert.match(
    intro,
    /`default` \(Default\): no capability-profiles\/default\.json/,
  );
  const peer = galleryIntro("p8-2", "a", "b", WALKS);
  assert.match(peer, /verify-peer-trust-two-context\.mjs/);
});

test("writeReadme and writeJourney emit the gallery files", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "round8-sheets-"));
  const { sheets } = dropSheets(
    WALKS,
    capturedWith(() => dropMeasure("x")),
    [VIEWS[0]],
  );
  writeReadme(dir, "Gallery title", " intro line ", sheets);
  const readme = fs.readFileSync(path.join(dir, "README.md"), "utf8");
  assert.match(readme, /^# Gallery title\n\nintro line\n/);
  assert.match(
    readme,
    /!\[minimal-local — share and drop ready, 1280 × 900\]\(minimal-local-1280\.png\)/,
  );
  writeJourney(dir, { out: ".", profiles: ["minimal-local"] });
  const journey = JSON.parse(
    fs.readFileSync(path.join(dir, "journey.json"), "utf8"),
  );
  assert.deepEqual(journey.profiles, ["minimal-local"]);
});
