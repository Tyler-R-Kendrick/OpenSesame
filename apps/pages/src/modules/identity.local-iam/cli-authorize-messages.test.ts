import { describe, expect, it } from "vitest";
import {
  CLI_AUTHORIZE_LOAD_BLOCKED,
  CLI_AUTHORIZE_LOAD_UNREADABLE,
  CLI_AUTHORIZE_PASSKEY_MISSING,
  CLI_AUTHORIZE_PASSKEY_NAME,
  CLI_AUTHORIZE_PASSKEY_UNSUPPORTED,
  cliAuthorizeRespondMessage,
} from "./cli-authorize-messages.js";

describe("CLI authorize copy", () => {
  it("says pairing is optional, needs a passkey on your own deployment, and is blocked here", () => {
    expect(CLI_AUTHORIZE_LOAD_BLOCKED).toMatch(/optional/i);
    expect(CLI_AUTHORIZE_LOAD_BLOCKED).toMatch(/own deployment/i);
    expect(CLI_AUTHORIZE_LOAD_BLOCKED).toMatch(/passkey/i);
    expect(CLI_AUTHORIZE_LOAD_BLOCKED).toMatch(/blocked on this site/i);
    expect(CLI_AUTHORIZE_LOAD_BLOCKED).not.toMatch(
      /localhost|127\.0\.0\.1|daemon|host/i,
    );
    expect(CLI_AUTHORIZE_LOAD_UNREADABLE).toBe(
      "Couldn't check for CLI requests.",
    );
    expect(CLI_AUTHORIZE_PASSKEY_NAME).toBe("Authorize with passkey");
    for (const sentence of [
      CLI_AUTHORIZE_PASSKEY_MISSING,
      CLI_AUTHORIZE_PASSKEY_UNSUPPORTED,
    ]) {
      expect(sentence).not.toMatch(/localhost|127\.0\.0\.1|daemon|host/i);
    }
    expect(cliAuthorizeRespondMessage("wrongSession")).not.toBe(
      cliAuthorizeRespondMessage("expired"),
    );
  });
});
