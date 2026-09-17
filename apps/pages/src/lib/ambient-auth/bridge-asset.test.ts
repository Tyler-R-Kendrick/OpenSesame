import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = join(dirname(fileURLToPath(import.meta.url)), "../../../auth");

describe("MSAL redirect bridge asset", () => {
  it("WEB-BRIDGE: source does not boot React or run SSO/admission", () => {
    const html = readFileSync(join(root, "redirect.html"), "utf8");
    const ts = readFileSync(join(root, "redirect-bridge.ts"), "utf8");
    expect(html).toContain("redirect-bridge.ts");
    expect(html).not.toMatch(/createRoot|react-dom|App\.tsx/i);
    expect(ts).toContain("@azure/msal-browser/redirect-bridge");
    expect(ts).toContain("broadcastResponseToMainFrame");
    expect(ts).not.toMatch(/admitAmbient|createGuest|beginSignIn|createRoot/);
    expect(ts).not.toMatch(/from ["']react["']/);
  });
});
