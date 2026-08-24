import { type JsonObject, overlapCast } from "@opensesame/os-domain";
/** @vitest-environment jsdom */
import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { QrCode, type QrCodeProps } from "./QrCode.js";

overlapCast(globalThis).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  container.remove();
});

async function renderQr(props: QrCodeProps) {
  await act(async () => {
    root.render(<QrCode {...props} />);
  });
}

describe("QrCode", () => {
  it("renders a data-URI SVG image for a valid payload", async () => {
    await renderQr({ value: "otpauth://totp/dev", label: "scan me" });
    const img = container.querySelector("img");
    expect(img).not.toBeNull();
    expect(img?.getAttribute("src")).toMatch(
      /^data:image\/svg\+xml;charset=utf-8,/,
    );
    expect(img?.getAttribute("alt")).toBe("scan me");
    expect(img?.getAttribute("width")).toBe("160");
    expect(img?.getAttribute("height")).toBe("160");
  });

  it("honors a custom size", async () => {
    await renderQr({ value: "otpauth://totp/dev", label: "scan me", size: 96 });
    const img = container.querySelector("img");
    expect(img?.getAttribute("width")).toBe("96");
    expect(img?.getAttribute("height")).toBe("96");
  });

  it("renders nothing for an empty payload", async () => {
    await renderQr({ value: "", label: "scan me" });
    expect(container.querySelector("img")).toBeNull();
  });

  it("renders nothing for a whitespace-only payload", async () => {
    await renderQr({ value: "   ", label: "scan me" });
    expect(container.querySelector("img")).toBeNull();
  });

  it("renders nothing when encoding fails (payload too large)", async () => {
    await renderQr({ value: "x".repeat(5000), label: "scan me" });
    expect(container.querySelector("img")).toBeNull();
  });
});
