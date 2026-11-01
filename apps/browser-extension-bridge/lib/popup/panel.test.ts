// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { renderPanel } from "./panel.js";

const APP = "https://opensesame-labs.github.io";
const actions = () => ({
  toggleSite: vi.fn(),
  allow: vi.fn(),
  revoke: vi.fn(),
});

function draw(status: Parameters<typeof renderPanel>[1], run = actions()) {
  const root = document.createElement("div");
  renderPanel(root, status, run);
  return { root, run };
}

describe("the popup panel", () => {
  it("offers the site switch only where there is an origin, and says what it does", () => {
    const off = draw({
      origin: null,
      enabled: false,
      pending: [],
      granted: [],
    });
    expect(off.root.querySelector("[role=switch]")).toBeNull();
    expect(off.root.textContent).toContain(
      "Open the OpenSesame app in this tab",
    );

    const on = draw({ origin: APP, enabled: true, pending: [], granted: [] });
    const toggle = on.root.querySelector("[role=switch]");
    expect(toggle?.getAttribute("aria-checked")).toBe("true");
    expect(toggle?.getAttribute("aria-label")).toBe(
      "Turn the bridge off for this site",
    );
    toggle?.dispatchEvent(new Event("click"));
    expect(on.run.toggleSite).toHaveBeenCalledOnce();
  });

  it("lists what waits with a labelled key to allow it, and runs nothing on load", () => {
    const { root, run } = draw({
      origin: APP,
      enabled: true,
      pending: [{ host: "api.plivo.com", providers: ["plivo"] }],
      granted: [],
    });
    expect(run.allow).not.toHaveBeenCalled();
    const key = root.querySelector("button[aria-label='Allow api.plivo.com']");
    expect(key?.getAttribute("title")).toBe("Allow api.plivo.com");
    expect(root.textContent).toContain("plivo");
    key?.dispatchEvent(new Event("click"));
    expect(run.allow).toHaveBeenCalledWith("api.plivo.com");
  });

  it("lists what is allowed with a key to stop allowing it", () => {
    const { root, run } = draw({
      origin: APP,
      enabled: true,
      pending: [],
      granted: [{ host: "api.plivo.com", providers: ["plivo", "other"] }],
    });
    root
      .querySelector("button[aria-label='Stop allowing api.plivo.com']")
      ?.dispatchEvent(new Event("click"));
    expect(run.revoke).toHaveBeenCalledWith("api.plivo.com");
    expect(root.textContent).toContain("plivo, other");
  });

  it("says plainly when nothing waits and nothing is allowed", () => {
    const { root } = draw({
      origin: APP,
      enabled: false,
      pending: [],
      granted: [],
    });
    expect(root.textContent).toContain("Nothing is waiting.");
    expect(root.textContent).toContain("No host is allowed yet.");
  });

  it("draws every host name as text, never as markup", () => {
    const { root } = draw({
      origin: APP,
      enabled: true,
      pending: [
        { host: "<img src=x onerror=alert(1)>", providers: ["<b>x</b>"] },
      ],
      granted: [],
    });
    expect(root.querySelector("img")).toBeNull();
    expect(root.querySelector("b")).toBeNull();
  });
});
