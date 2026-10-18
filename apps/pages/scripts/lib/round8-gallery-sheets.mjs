/**
 * Round 8 install-profile evidence: the galleries.
 *
 * Turns the captured per-cell measurements into the composed before/after
 * sheets, each gallery's README.md and its journey.json under
 * `docs/evidence/`. The captions carry the measurement that makes the
 * difference a fact: the Opens on row for a drop, the fingerprint, SAS and
 * admit control for peer trust.
 */

import fs from "node:fs";
import path from "node:path";
import { JOINER, REPO, SHOT_ROOT, log } from "./round8-profile-plan.mjs";
import { WALK_NAMES } from "./verification-checklist-profiles.mjs";
import { composeSheet } from "./visual-evidence.mjs";

export function q(value) {
  if (value === null || value === undefined || value === "") return "absent";
  return `“${value}”`;
}

export function dropCaption(profile, view, before, after, kind) {
  const left = before[kind];
  const right = after[kind];
  const place = kind === "share" ? "Share once, before seal" : "Drop ready";
  return [
    `${place} on ${profile} at ${view.width} × ${view.height}.`,
    `Before: Opens on is ${q(left.opensOn)} (${left.any} × Any browser with the link, ${left.here} × This browser, ${left.warning} × device-only warning).`,
    `After: Opens on is ${q(right.opensOn)} (${right.any} × Any browser with the link, ${right.here} × This browser, ${right.warning} × device-only warning).`,
  ].join(" ");
}

export function dropNote(measure) {
  return `Opens on ${q(measure.opensOn)} · any ${measure.any} · this browser ${measure.here}`;
}

export function peerExportCaption(profile, view, before, after) {
  return [
    `Host peer-trust export on ${profile} at ${view.width} × ${view.height}, after Start the live session.`,
    `Before: Fingerprint ${q(before.fingerprint)}, Short authentication string ${q(before.shortAuth)}, copy control ${before.copy}, Show fingerprint QR ${before.qr}, unavailable ${before.unavailable}.`,
    `After: Fingerprint ${q(after.fingerprint)}, Short authentication string ${q(after.shortAuth)}, copy control ${after.copy}, Show fingerprint QR ${after.qr}, unavailable ${after.unavailable}.`,
  ].join(" ");
}

export function peerCompareCaption(profile, view, before, after) {
  const same =
    after.rowSas !== "" && after.rowSas === after.joinerSas
      ? "The host row and the joiner show the same SAS."
      : "The host row and the joiner do not show one shared SAS.";
  const trouble = [before.compareError, after.compareError]
    .filter(Boolean)
    .join(" ");
  return [
    `Host admit control for ${JOINER} on ${profile} at ${view.width} × ${view.height}, after the joiner asks with the copied signal and the host reads the request.`,
    `Before: Yes, they match ${before.match}, Let ${JOINER} in ${before.letIn}, guest-row SAS ${q(before.rowSas)}, joiner SAS ${q(before.joinerSas)}.`,
    `After: Yes, they match ${after.match}, Let ${JOINER} in ${after.letIn}, guest-row SAS ${q(after.rowSas)}, joiner SAS ${q(after.joinerSas)}. ${same}`,
    trouble ? `Capture note: ${trouble}` : "",
  ]
    .filter(Boolean)
    .join(" ");
}

export function peerExportNote(measure) {
  const shown = measure.fingerprint ?? measure.shortAuth;
  const label =
    measure.fingerprint !== null
      ? "Fingerprint"
      : "Short authentication string";
  return `${label} ${q(shown)} · QR ${measure.qr}`;
}

export function peerCompareNote(measure) {
  if (measure.match > 0)
    return `Yes, they match ${measure.match} · SAS ${q(measure.rowSas)}`;
  if (measure.letIn > 0) return `Let ${JOINER} in ${measure.letIn}`;
  return measure.compareError || "admit control absent";
}

export function htmlEscape(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

async function composeGallery(browser, dir, sheets, beforeDir, afterDir) {
  fs.mkdirSync(dir, { recursive: true });
  for (const sheet of sheets) {
    const spec = {
      ...sheet,
      title: htmlEscape(sheet.title),
      caption: htmlEscape(sheet.caption),
      rows: sheet.rows.map((row) => ({
        ...row,
        heading: htmlEscape(row.heading),
        before: htmlEscape(row.before),
        after: htmlEscape(row.after),
      })),
    };
    await composeSheet(
      browser,
      spec,
      { before: beforeDir, after: afterDir },
      dir,
    );
    log(`sheet ${path.join(dir, `${sheet.shot}.png`)}`);
  }
}

export function writeReadme(dir, title, intro, sheets) {
  const parts = [`# ${title}`, "", intro.trim(), ""];
  for (const sheet of sheets) {
    parts.push(
      `## ${sheet.title}`,
      "",
      sheet.caption,
      "",
      `![${sheet.title}](${sheet.shot}.png)`,
      "",
    );
  }
  fs.writeFileSync(path.join(dir, "README.md"), `${parts.join("\n")}\n`);
}

export function writeJourney(dir, journey) {
  fs.writeFileSync(
    path.join(dir, "journey.json"),
    `${JSON.stringify(journey, null, 2)}\n`,
  );
}

export function dropSheets(walks, captured, views) {
  const sheets = [];
  const screens = [];
  for (const walk of walks) {
    for (const view of views) {
      const before = captured.before[walk.name][view.id];
      const after = captured.after[walk.name][view.id];
      const stem = `${walk.name}-${view.id}`;
      const shareCaption = dropCaption(walk.name, view, before, after, "share");
      const readyCaption = dropCaption(walk.name, view, before, after, "ready");
      sheets.push({
        shot: stem,
        width: view.width,
        title: `${walk.name} — share and drop ready, ${view.width} × ${view.height}`,
        caption: `${shareCaption} ${readyCaption}`,
        rows: [
          {
            shot: `${stem}-share`,
            heading: "Share once",
            before: dropNote(before.share),
            after: dropNote(after.share),
          },
          {
            shot: `${stem}-ready`,
            heading: "Drop ready",
            before: dropNote(before.ready),
            after: dropNote(after.ready),
          },
        ],
      });
      screens.push({
        width: view.width,
        height: view.height,
        desktop: view.desktop,
        profile: walk.name,
        buildKey: walk.buildKey,
        steps: [
          { guest: null },
          { visit: "/vault/new" },
          { press: "Share once" },
          { shot: `${stem}-share` },
          { press: "Seal and share" },
          { shot: `${stem}-ready` },
        ],
      });
    }
  }
  return { sheets, screens };
}

export function peerSheets(walks, captured, views) {
  const sheets = [];
  const screens = [];
  for (const walk of walks) {
    for (const view of views) {
      const before = captured.before[walk.name][view.id];
      const after = captured.after[walk.name][view.id];
      const stem = `${walk.name}-${view.id}`;
      sheets.push({
        shot: stem,
        width: view.width,
        title: `${walk.name} — peer trust, ${view.width} × ${view.height}`,
        caption: `${peerExportCaption(walk.name, view, before, after)} ${peerCompareCaption(walk.name, view, before, after)}`,
        rows: [
          {
            shot: `${stem}-export`,
            heading: "Host export",
            before: peerExportNote(before),
            after: peerExportNote(after),
          },
          {
            shot: `${stem}-compare`,
            heading: "Admit",
            before: peerCompareNote(before),
            after: peerCompareNote(after),
          },
        ],
      });
      screens.push({
        width: view.width,
        height: view.height,
        desktop: view.desktop,
        profile: walk.name,
        buildKey: walk.buildKey,
        steps: [
          { guest: null },
          { tab: "Settings" },
          { press: "Live sessions" },
          { press: "Start the live session" },
          { shot: `${stem}-export` },
          { press: "Ask to join" },
          { press: "Read the request" },
          { shot: `${stem}-compare` },
        ],
      });
    }
  }
  return { sheets, screens };
}

export function galleryIntro(kind, beforeSha, afterSha, walks) {
  const lines = walks.map((walk) => {
    const how = walk.capabilityProfile
      ? `capability profile ${path.basename(walk.capabilityProfile)}`
      : walk.note;
    return `- \`${walk.name}\` (${walk.setupChoice}): ${how}`;
  });
  const subject =
    kind === "p8-1"
      ? "Guest flow, same steps as `verify-portable-drop.mjs`: Skip on the front door, a new secret, Share once, then Seal and share. The pair is the Opens on row on the share form and again inside Drop ready."
      : "Guest flow into a live session, the same host steps as `verify-peer-trust-two-context.mjs` through the admit control. The joiner pastes the copied peer-trust signal and asks. The host reads the request. The sheet stops there, with Yes, they match or Let in still on screen. WebRTC connect is not part of this gallery.";
  return [
    `Before \`${beforeSha}\`. After \`${afterSha}\`.`,
    "Each profile is a real Pages dist: `security-profile.mjs`, then `vite build` with `VITE_BASE=/OpenSesame/`. Desktop is 1280 × 900 with a mouse. Phone is 390 × 844, touch, coarse pointer.",
    subject,
    "Profiles:",
    ...lines,
  ].join("\n\n");
}

export async function emitGallery({
  browser,
  feature,
  title,
  folder,
  beforeSha,
  afterSha,
  walks,
  captured,
  sheetsOf,
  views,
}) {
  const dir = path.join(REPO, "docs/evidence", folder);
  const { sheets, screens } = sheetsOf(walks, captured, views);
  await composeGallery(
    browser,
    dir,
    sheets,
    path.join(SHOT_ROOT, feature, "before"),
    path.join(SHOT_ROOT, feature, "after"),
  );
  const intro = galleryIntro(feature, beforeSha, afterSha, walks);
  writeReadme(dir, title, intro, sheets);
  writeJourney(dir, {
    out: ".",
    driver: "apps/pages/scripts/capture-round8-profile-evidence.mjs",
    before: beforeSha,
    after: afterSha,
    profiles: WALK_NAMES,
    screens,
    sheets: sheets.map((sheet) => ({
      shot: sheet.shot,
      width: sheet.width,
      title: sheet.title,
      caption: sheet.caption,
      before: sheet.rows.map((row) => row.before).join(" · "),
      after: sheet.rows.map((row) => row.after).join(" · "),
    })),
    measurements: captured,
  });
}
