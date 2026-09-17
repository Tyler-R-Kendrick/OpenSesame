/** @vitest-environment jsdom */
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { secretConfigSeams } from "../../lib/secret-configs.js";
import { SecretConfigEmptyCreate } from "./SecretConfigEmptyCreate.js";

const createSecretConfig = vi.spyOn(secretConfigSeams, "createSecretConfig");

afterEach(() => {
  cleanup();
  createSecretConfig.mockReset();
});

describe("SecretConfigEmptyCreate", () => {
  it("creates a config through the Host seam without a REST snippet", async () => {
    createSecretConfig.mockResolvedValue({
      id: "cfg_1",
      organizationId: "org_1",
      projectId: "project_1",
      slug: "default",
      displayName: "default",
      environment: "development",
      parentConfigId: null,
      createdAt: "2026-09-17T00:00:00Z",
      updatedAt: "2026-09-17T00:00:00Z",
    });
    const onCreated = vi.fn();
    render(
      <SecretConfigEmptyCreate projectId="project_1" onCreated={onCreated} />,
    );
    expect(screen.queryByText(/POST \/api\/v1\/projects/)).toBeNull();
    await userEvent.click(
      screen.getByRole("button", { name: "Create config" }),
    );
    await waitFor(() =>
      expect(createSecretConfig).toHaveBeenCalledWith("project_1", {
        slug: "default",
        environment: "development",
      }),
    );
    expect(onCreated).toHaveBeenCalled();
  });
});
