// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { resumeNativeAuthPopup } from "./native-auth-session.js";

function originalWindow(): Window {
  const frame = document.createElement("iframe");
  document.body.append(frame);
  const popup = frame.contentWindow;
  if (!popup) throw new Error("Expected an owned blank browsing context");
  Object.defineProperty(popup, "opener", { value: window, configurable: true });
  vi.spyOn(popup, "close").mockImplementation(() => undefined);
  return popup;
}
afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});
it("hands the exact owned blank window to the existing one-use popup base only once", () => {
  const popup = originalWindow();
  const reservation = resumeNativeAuthPopup(popup);
  expect(() => resumeNativeAuthPopup(popup)).toThrow("original unused");
  reservation.cancel();
  expect(popup.close).toHaveBeenCalledOnce();
  expect(() => resumeNativeAuthPopup(popup)).toThrow("original unused");
});
it("refuses a window whose original opener is gone", () => {
  const popup = originalWindow();
  Object.defineProperty(popup, "opener", { value: null });
  expect(() => resumeNativeAuthPopup(popup)).toThrow("original unused");
});
it("refuses an already-closed window before any form or navigation", () => {
  const popup = originalWindow();
  Object.defineProperty(popup, "closed", { value: true });
  expect(() => resumeNativeAuthPopup(popup)).toThrow("original unused");
});
it("refuses a window navigated during lazy protocol loading", () => {
  const popup = originalWindow();
  popup.location.hash = "retargeted";
  expect(() => resumeNativeAuthPopup(popup)).toThrow("original unused");
});
