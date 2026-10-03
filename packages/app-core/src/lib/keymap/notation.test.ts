/** @vitest-environment jsdom */
/**
 * ADR 0155: which presses become a token. Alt, Option and AltGr make
 * characters on many layouts (`@` is Option+L on a German Mac, AltGr+Q on a
 * German Windows keyboard), and the keymap must be able to bind them; Alt with
 * a letter or a digit is the browser's mnemonic and Meta is the platform's.
 */
import { describe, expect, it } from "vitest";
import { tokenFromPress } from "./notation.js";

describe("a symbol made with Alt, Option or AltGr", () => {
  it("is the symbol alone when Option or Alt made it", () => {
    expect(tokenFromPress({ key: "@", altKey: true })).toBe("@");
    expect(tokenFromPress({ key: "€", altKey: true })).toBe("€");
    expect(tokenFromPress({ key: "|", altKey: true, shiftKey: true })).toBe(
      "|",
    );
  });

  it("is the symbol alone for AltGr on Windows, which reports Control+Alt", () => {
    expect(tokenFromPress({ key: "@", ctrlKey: true, altKey: true })).toBe("@");
    expect(
      tokenFromPress({
        key: "\\",
        ctrlKey: true,
        altKey: true,
        altGraph: true,
      }),
    ).toBe("\\");
  });

  it("is the symbol alone when AltGraph is held without Alt", () => {
    expect(tokenFromPress({ key: "@", ctrlKey: true, altGraph: true })).toBe(
      "@",
    );
    expect(tokenFromPress({ key: "@", altGraph: true })).toBe("@");
  });

  it("reads AltGraph from a keyboard event's own getModifierState", () => {
    const press = {
      key: "{",
      ctrlKey: true,
      getModifierState: (name: string) => name === "AltGraph",
    };
    expect(tokenFromPress(press)).toBe("{");
    expect(
      tokenFromPress({
        key: "{",
        ctrlKey: true,
        getModifierState: () => false,
      }),
    ).toBe("Control+{");
  });

  it("reads a real KeyboardEvent", () => {
    const event = new KeyboardEvent("keydown", {
      key: "@",
      ctrlKey: true,
      altKey: true,
      modifierAltGraph: true,
    });
    expect(tokenFromPress(event)).toBe("@");
  });

  it("still refuses Alt with a letter, a digit, a named key or Space", () => {
    expect(tokenFromPress({ key: "f", altKey: true })).toBeNull();
    expect(
      tokenFromPress({ key: "F", altKey: true, shiftKey: true }),
    ).toBeNull();
    expect(tokenFromPress({ key: "1", altKey: true })).toBeNull();
    expect(tokenFromPress({ key: "ArrowLeft", altKey: true })).toBeNull();
    expect(tokenFromPress({ key: " ", altKey: true })).toBeNull();
    expect(
      tokenFromPress({ key: "d", ctrlKey: true, altKey: true }),
    ).toBeNull();
  });

  it("still refuses Meta, whatever else is held", () => {
    expect(tokenFromPress({ key: "@", metaKey: true })).toBeNull();
    expect(
      tokenFromPress({ key: "@", metaKey: true, altKey: true }),
    ).toBeNull();
    expect(
      tokenFromPress({ key: "@", metaKey: true, altGraph: true }),
    ).toBeNull();
  });

  it("leaves Control with a symbol, and plain symbols, as they were", () => {
    expect(tokenFromPress({ key: "]", ctrlKey: true })).toBe("Control+]");
    expect(tokenFromPress({ key: "@" })).toBe("@");
    expect(tokenFromPress({ key: "d", ctrlKey: true })).toBe("Control+d");
  });
});
