import { cleanup, render, screen } from "@testing-library/react";
/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";

const fail = vi.hoisted(() => ({ current: false }));

import { QrCode, qrSeams } from "./QrCode.js";

const originalQrSeams = { ...qrSeams };
Object.assign(qrSeams, {
  encodeQrSvg: (
    value: string,
    options?: Parameters<typeof originalQrSeams.encodeQrSvg>[1],
  ) => {
    if (fail.current) throw new Error("encoder exploded");
    return originalQrSeams.encodeQrSvg(value, options);
  },
});

describe("QrCode", () => {
  afterEach(() => {
    cleanup();
    fail.current = false;
  });

  it("renders a data-URL SVG with the accessible label", () => {
    render(<QrCode value="https://example.com/pair" label="Scan to pair" />);
    const img = screen.getByRole("img", { name: "Scan to pair" });
    expect(img.getAttribute("src")).toMatch(/^data:image\/svg\+xml/);
    // Default square size.
    expect(img.getAttribute("width")).toBe("144");
    expect(img.getAttribute("height")).toBe("144");
  });

  it("honours a custom size and merges class names", () => {
    render(
      <QrCode
        value="https://example.com/pair"
        label="Scan to pair"
        size={96}
        className="qr--hero"
      />,
    );
    const img = screen.getByRole("img", { name: "Scan to pair" });
    expect(img.getAttribute("width")).toBe("96");
    expect(img.closest("figure")?.className).toBe("qr qr--hero");
  });

  it("shows the shortcode caption when provided", () => {
    render(
      <QrCode
        value="https://example.com"
        label="Scan me"
        shortcode="ABCD-EFGH"
      />,
    );
    expect(screen.getByText("ABCD-EFGH")).toBeTruthy();
  });

  it("renders nothing for an empty or whitespace value", () => {
    const { container } = render(<QrCode value="   " label="Scan me" />);
    expect(container.firstChild).toBeNull();
  });

  it("renders nothing when the encoder throws", () => {
    fail.current = true;
    const { container } = render(
      <QrCode value="https://example.com/broken" label="Scan me" />,
    );
    expect(container.firstChild).toBeNull();
  });
});
