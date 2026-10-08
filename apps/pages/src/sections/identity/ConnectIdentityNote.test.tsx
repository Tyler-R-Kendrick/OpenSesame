/** @vitest-environment jsdom */
import * as identityService from "@opensesame/app-core/lib/identity-service.js";
import {
  loadSettings,
  saveSettings,
} from "@opensesame/app-core/lib/settings.js";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { identityHookSeams } from "../../bindings/identity.js";
import { ConnectIdentityNote } from "./ConnectIdentityNote.js";

const connect = vi.fn();

beforeEach(() => {
  Object.assign(identityHookSeams, {
    useConnect: () => ({ connect, connecting: false, error: null }),
    useIdentitySession: () => null,
  });
  saveSettings({ ...loadSettings(), identityApi: "" });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("ConnectIdentityNote", () => {
  it("draws the sign-in service field when the issuer may be chosen", () => {
    render(<ConnectIdentityNote online what="agent identities" />);
    expect(screen.getByLabelText("Sign-in service")).toBeTruthy();
  });

  it("refuses to retarget the issuer on a locked ceremony", () => {
    const write = vi.spyOn(identityService, "writeSignInService");
    render(
      <ConnectIdentityNote online what="the requests sent to you" lockIssuer />,
    );
    expect(screen.queryByLabelText("Sign-in service")).toBeNull();
    expect(write).not.toHaveBeenCalled();
    write.mockRestore();
  });

  it("normalises a typed issuer before saving it", async () => {
    const write = vi.spyOn(identityService, "writeSignInService");
    render(<ConnectIdentityNote online what="agent identities" />);
    const field = screen.getByLabelText("Sign-in service");
    await userEvent.type(field, "https://login.example.com/");
    await userEvent.tab();
    expect(write).toHaveBeenCalledWith("https://login.example.com");
    write.mockRestore();
  });
});
