/** @vitest-environment jsdom */
import { readFileSync } from "node:fs";
import { URL as FileURL } from "node:url";
import { describe, expect, it } from "vitest";
import {
  APP_ICON,
  MARK_GAP_U,
  MARK_SLAB_U,
  MARK_SLIT_U,
  MARK_UNITS,
  markRects,
} from "./mark-geometry.js";

const iconSvg = readFileSync(
  new FileURL("../../../public/icon.svg", import.meta.url),
  "utf8",
);

function rects(svg: string) {
  return [...svg.matchAll(/<rect ([^>]*)\/>/g)].map((m) => {
    const attrs: Record<string, string> = {};
    for (const [, k, v] of m[1].matchAll(/([\w-]+)="([^"]*)"/g)) attrs[k] = v;
    return attrs;
  });
}

describe("the mark's geometry", () => {
  it("is a 17-unit square: slab 12, gap 2.7, slit 2.3", () => {
    expect(MARK_SLAB_U + MARK_GAP_U + MARK_SLIT_U).toBe(MARK_UNITS);
    const { slab, slit } = markRects(36);
    expect(slab.w).toBeCloseTo(25.41, 2);
    expect(slit.x).toBeCloseTo(31.13, 2);
    expect(slit.w).toBeCloseTo(4.87, 2);
    expect(slab.h).toBe(36);
  });

  it("is what public/icon.svg draws: a square tile, grey slit, no hue", () => {
    const [tile, slab, slit] = rects(iconSvg);
    expect(tile.rx).toBeUndefined();
    expect(tile.width).toBe(String(APP_ICON.tile));
    expect(tile.fill).toBe(APP_ICON.tileFill);
    const want = markRects(APP_ICON.mark, APP_ICON.inset, APP_ICON.inset);
    expect(Number(slab.x)).toBeCloseTo(want.slab.x, 2);
    expect(Number(slab.width)).toBeCloseTo(want.slab.w, 2);
    expect(Number(slab.height)).toBe(want.slab.h);
    expect(slab.fill).toBe(APP_ICON.slabFill);
    expect(Number(slit.x)).toBeCloseTo(want.slit.x, 2);
    expect(Number(slit.width)).toBeCloseTo(want.slit.w, 2);
    expect(slit.fill).toBe(APP_ICON.slitFill);
    expect(iconSvg).not.toMatch(/#2fb3a3|#0d7268/i);
  });

  it("embeds the canonical tab icon while retaining the external install icon", () => {
    const html = readFileSync(
      new FileURL("../../../index.html", import.meta.url),
      "utf8",
    );
    const document = new DOMParser().parseFromString(html, "text/html");
    const icons = document.head.querySelectorAll('link[rel~="icon"]');
    expect(icons).toHaveLength(1);
    expect(icons[0].getAttribute("type")).toBe("image/svg+xml");
    const icon = new URL(
      icons[0].getAttribute("href") ?? "",
      "https://example.test/",
    );
    expect(icon.protocol).toBe("data:");
    const comma = icon.pathname.indexOf(",");
    expect(icon.pathname.slice(0, comma)).toBe("image/svg+xml;base64");
    expect(
      Buffer.from(icon.pathname.slice(comma + 1), "base64").toString("utf8"),
    ).toBe(iconSvg);
    expect(icon.search).toBe("");
    expect(icon.hash).toBe("");
    const installIcons = document.head.querySelectorAll(
      'link[rel~="apple-touch-icon"]',
    );
    expect(installIcons).toHaveLength(1);
    expect(installIcons[0].getAttribute("href")).toBe("/icon-192.png");
    const installIcon = readFileSync(
      new FileURL("../../../public/icon-192.png", import.meta.url),
    );
    expect([...installIcon.subarray(0, 8)]).toEqual([
      137, 80, 78, 71, 13, 10, 26, 10,
    ]);
    expect(installIcon.readUInt32BE(8)).toBe(13);
    expect(installIcon.toString("ascii", 12, 16)).toBe("IHDR");
    expect(installIcon.readUInt32BE(16)).toBe(192);
    expect(installIcon.readUInt32BE(20)).toBe(192);
  });
});
