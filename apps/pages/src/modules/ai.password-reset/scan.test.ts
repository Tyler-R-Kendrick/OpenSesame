import { activeCapabilityVaultId } from "@opensesame/app-core/lib/capability-connector-scope.js";
import {
  addResetEmail,
  installAutonomousResetReady,
  passwordResetMailSeams,
  resetPasswordResetMailForTest,
} from "@opensesame/app-core/lib/password-reset-mail.js";
import { afterEach, describe, expect, it } from "vitest";
import { clearPasswordResetSeen, scanPasswordResetMail } from "./scan.js";

afterEach(() => {
  resetPasswordResetMailForTest();
  clearPasswordResetSeen();
});

describe("password reset scan", () => {
  it("does not post while the ceremony is off", async () => {
    const vault = activeCapabilityVaultId();
    const email = addResetEmail("a@example.com", vault);
    passwordResetMailSeams.listMessages = async () => [
      {
        mailbox: "a@example.com",
        subject: "Reset your password",
        text: "https://example.com/reset/abc",
      },
    ];
    const posted: string[] = [];
    await scanPasswordResetMail({
      items: [
        {
          id: "login-1",
          resetEmailId: email?.id,
          uris: ["https://example.com/login"],
        },
      ],
      post: async (origin) => {
        posted.push(origin);
        return true;
      },
    });
    expect(posted).toEqual([]);
  });

  it("posts the origin once, and retries a post that did not land", async () => {
    const uninstall = installAutonomousResetReady(() => true);
    const vault = activeCapabilityVaultId();
    const email = addResetEmail("a@example.com", vault);
    passwordResetMailSeams.listMessages = async () => [
      {
        mailbox: "a@example.com",
        subject: "Reset your password",
        text: "https://example.com/reset/abc",
      },
    ];
    const items = [
      {
        id: "login-1",
        resetEmailId: email?.id,
        uris: ["https://example.com/login"],
      },
    ];
    const posted: string[] = [];
    let ok = false;
    const post = async (origin: string) => {
      posted.push(origin);
      return ok;
    };
    await scanPasswordResetMail({ items, post });
    expect(posted).toEqual(["https://example.com"]);
    ok = true;
    await scanPasswordResetMail({ items, post });
    expect(posted).toEqual(["https://example.com", "https://example.com"]);
    await scanPasswordResetMail({ items, post });
    expect(posted).toEqual(["https://example.com", "https://example.com"]);
    uninstall();
  });
});
