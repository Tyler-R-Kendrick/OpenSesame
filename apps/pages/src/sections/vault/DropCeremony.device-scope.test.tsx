import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
/** @vitest-environment jsdom */
import { describe, expect, it } from "vitest";

import { deviceIdentitySeams } from "@opensesame/app-core/lib/device-identity.js";

import {
  Ceremony,
  installDropCeremonyHarness,
  makeSecret,
} from "./DropCeremony.test-support.js";

installDropCeremonyHarness();

describe("share ceremony device scope (PF-02)", () => {
  it("hides the device-scope line when a cross-device claim host is configured", async () => {
    const local = deviceIdentitySeams.remoteIdentityApi;
    deviceIdentitySeams.remoteIdentityApi = () => "https://id.example.com";
    try {
      const user = userEvent.setup();
      render(<Ceremony item={makeSecret()} />);
      expect(screen.queryByText("Opens on")).toBeNull();
      expect(screen.queryByText("This browser")).toBeNull();

      await user.click(screen.getByRole("button", { name: /Seal and share/i }));
      await screen.findByText("Drop ready");
      const ready = screen.getByRole("region", { name: "Drop ready" });
      expect(ready.textContent).not.toMatch(/Opens on/);
      expect(ready.textContent).toMatch(/Opens for\s*1 hour/);
    } finally {
      deviceIdentitySeams.remoteIdentityApi = local;
    }
  });
});
