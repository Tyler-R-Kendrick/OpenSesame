import { vi } from "vitest";
import * as popupPort from "../browser/native-auth-session.js";

export function configuredSamlPopup(events: string[]) {
  vi.spyOn(window, "open").mockImplementation(() => {
    events.push("popup");
    return window;
  });
  vi.spyOn(popupPort, "resumeNativeAuthPopup").mockReturnValue({
    cancel: vi.fn(),
    wait: vi.fn(),
    waitWebMessage: vi.fn(),
    showDeviceConsent: vi.fn(),
    showRedirectConsent: vi.fn(),
    showFormConsent: vi.fn(() => ({
      signal: new AbortController().signal,
      close() {},
    })),
  });
}
