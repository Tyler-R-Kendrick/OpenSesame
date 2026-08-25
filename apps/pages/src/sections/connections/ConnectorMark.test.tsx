/** @vitest-environment jsdom */
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ConnectorMark } from "./ConnectorMark.js";
import { adaptiveHex, connectorMark, monogram } from "./connector-marks.js";

afterEach(cleanup);

describe("connector-marks", () => {
  it("keeps readable brand colors and drops near-black ones", () => {
    // Linear's indigo survives; GitHub's near-black falls back to ink.
    expect(adaptiveHex("5E6AD2")).toBe("#5E6AD2");
    expect(adaptiveHex("181717")).toBeNull();
    expect(adaptiveHex("000000")).toBeNull();
    expect(adaptiveHex("zz")).toBeNull();
  });

  it("knows well-known providers and not made-up ones", () => {
    expect(connectorMark("github")).not.toBeNull();
    expect(connectorMark("linear")).not.toBeNull();
    expect(connectorMark("no-such-provider")).toBeNull();
  });

  it("monograms from the display name", () => {
    expect(monogram("stripe")).toBe("S");
    expect(monogram("  ")).toBe("?");
  });
});

describe("ConnectorMark", () => {
  it("renders a brand path for a known provider", () => {
    const { container } = render(
      <ConnectorMark providerId="linear" displayName="Linear" />,
    );
    const path = container.querySelector("svg path");
    expect(path).not.toBeNull();
    expect(container.querySelector("svg")?.getAttribute("fill")).toBe(
      "#5E6AD2",
    );
  });

  it("renders dark-hex brands in the ink color", () => {
    const { container } = render(
      <ConnectorMark providerId="github" displayName="GitHub" />,
    );
    expect(container.querySelector(".conn-mark--ink")).not.toBeNull();
    expect(container.querySelector("svg")?.getAttribute("fill")).toBe(
      "currentColor",
    );
  });

  it("renders Microsoft's four tiles", () => {
    const { container } = render(
      <ConnectorMark providerId="azure-kms" displayName="Azure Key Vault" />,
    );
    expect(container.querySelectorAll("svg rect").length).toBe(4);
  });

  it("falls back to a monogram for unknown providers", () => {
    const { container } = render(
      <ConnectorMark providerId="acme-internal" displayName="Acme Internal" />,
    );
    expect(container.querySelector(".conn-mark--monogram")?.textContent).toBe(
      "A",
    );
    expect(container.querySelector("svg")).toBeNull();
  });
});
