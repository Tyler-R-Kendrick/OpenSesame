/** @vitest-environment jsdom */
import { observeControlledIdentifier } from "@opensesame/app-core/lib/credential-canaries/observe.js";
import {
  contextSchema,
  controlledIdentifierDigest,
  presentedIdSchema,
} from "@opensesame/app-core/lib/credential-canaries/protocol.js";
import { listControlledCanaries } from "@opensesame/app-core/lib/credential-canaries/registry.js";
import { canaryRegistryKey } from "@opensesame/app-core/lib/credential-canaries/storage.js";
import { validatorBindingSchema } from "@opensesame/app-core/lib/credential-canaries/validator-binding.js";
import { kvGet } from "@opensesame/app-core/lib/kv.js";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { z } from "zod";
import CanaryCeremony, { canaryUiPorts } from "./CanaryCeremony.js";
import {
  RETIREMENTS,
  button,
  ceremonyOwner,
  gate,
  inputPassword,
  passwordField,
  perform,
  releaseGate,
  restoreCeremonyOwner,
} from "./controlled-ceremony.test-support.js";

const original = { ...canaryUiPorts };
const releases: Array<() => void> = [];
afterEach(async () => {
  for (const release of releases.splice(0)) release();
  cleanup();
  Object.assign(canaryUiPorts, original);
  await restoreCeremonyOwner();
});

const exportedSchema = z
  .object({
    v: z.literal(1),
    tomb: z.literal("personal"),
    artifact: z
      .object({
        id: z.string().uuid(),
        context: z.unknown(),
        presentedId: z.string(),
      })
      .strict(),
    reference: z.string().optional(),
    validatorBinding: z.unknown().optional(),
    mcpServers: z
      .object({
        OpenSesameCanary: z
          .object({ command: z.string(), args: z.array(z.string()) })
          .strict(),
      })
      .strict()
      .optional(),
  })
  .strict();

function parseExport(raw: string) {
  // Pages and core use independent Zod majors; validate each boundary with
  // its owning schema instead of composing validators from different majors.
  const value = exportedSchema.parse(JSON.parse(raw));
  return {
    ...value,
    artifact: {
      ...value.artifact,
      context: contextSchema.parse(value.artifact.context),
      presentedId: presentedIdSchema.parse(value.artifact.presentedId),
    },
    validatorBinding:
      value.validatorBinding === undefined
        ? undefined
        : validatorBindingSchema.parse(value.validatorBinding),
  };
}

function downloads() {
  const capture = vi.fn<typeof canaryUiPorts.download>();
  canaryUiPorts.download = capture;
  return capture;
}

async function ready() {
  // The initial placeholder also says zero; admission requires actual durable status.
  inputPassword("unsubmitted generated readiness text");
  await waitFor(() =>
    expect(button("Create and export canary").disabled).toBe(false),
  );
  inputPassword("");
}

async function refused() {
  await waitFor(() =>
    expect(screen.getByRole("status").textContent).toContain("session"),
  );
  expect(passwordField().value).toBe("");
  expect(passwordField().disabled).toBe(false);
}

it("exports an operational MCP canary, renders actual observations and clears/revokes without exposing identifiers", async () => {
  const owner = await ceremonyOwner();
  const capture = downloads();
  let view = render(<CanaryCeremony tomb="personal" supported />);
  await ready();
  await perform("Create and export canary", owner.password);
  expect(capture).toHaveBeenCalledTimes(1);
  const [filename, body] = capture.mock.calls[0];
  expect(filename).toBe("opensesame-canary.json");
  const exported = parseExport(body);
  expect(exported.artifact.context.kind).toBe("mcp_configuration");
  expect(exported.mcpServers?.OpenSesameCanary).toEqual({
    command: "opensesame-id",
    args: ["canary", "serve", "--config", "opensesame-canary.json"],
  });
  expect(exported.validatorBinding?.artifactId).toBe(exported.artifact.id);
  expect(exported.validatorBinding?.context).toEqual(exported.artifact.context);
  expect(exported.validatorBinding?.digestB64).toBe(
    await controlledIdentifierDigest(
      exported.artifact.context,
      exported.artifact.presentedId,
    ),
  );
  expect(body).not.toContain(owner.password);
  expect(document.body.textContent).not.toContain(
    exported.artifact.presentedId,
  );
  expect(kvGet(canaryRegistryKey("personal"))).not.toContain(
    exported.artifact.presentedId,
  );
  for (const phase of ["connected", "invoked"] as const)
    expect(
      await observeControlledIdentifier({
        tomb: "personal",
        ...exported.artifact,
        phase,
      }),
    ).toMatchObject({ kind: "canary", response: "synthetic_readonly" });
  view.unmount();
  view = render(<CanaryCeremony tomb="personal" supported />);
  for (const label of [
    "Validator connected",
    "Synthetic tool invoked",
    "Artifact exported",
  ])
    await waitFor(() =>
      expect(screen.getByText(new RegExp(label))).toBeTruthy(),
    );
  await perform("Clear canary observations", owner.password);
  expect((await listControlledCanaries("personal")).events).toEqual([]);
  expect(screen.queryByText(/Validator connected/)).toBeNull();
  await perform("Revoke canary 1", owner.password);
  expect((await listControlledCanaries("personal")).artifacts).toEqual([]);
  expect(screen.queryByRole("button", { name: "Revoke canary 1" })).toBeNull();
  expect(capture).toHaveBeenCalledTimes(1);
});

it.each(["connection_ref", "token_generation", "agent_lease"] as const)(
  "exports a real %s artifact with only its controlled reference",
  async (kind) => {
    const owner = await ceremonyOwner();
    const capture = downloads();
    render(<CanaryCeremony tomb="personal" supported />);
    await ready();
    fireEvent.change(screen.getByLabelText("Canary type"), {
      target: { value: kind },
    });
    await perform("Create and export canary", owner.password);
    expect(capture).toHaveBeenCalledTimes(1);
    const exported = parseExport(capture.mock.calls[0][1]);
    expect(exported.artifact.context).toMatchObject({ kind, generation: 1 });
    expect(exported.reference).toBe(
      `oscanary:v1:${exported.artifact.presentedId}`,
    );
    expect(exported.mcpServers).toBeUndefined();
    expect(exported.validatorBinding).toBeUndefined();
    expect((await listControlledCanaries("personal")).artifacts).toMatchObject([
      { id: exported.artifact.id, state: "bait" },
    ]);
    expect(document.body.textContent).not.toContain(
      exported.artifact.presentedId,
    );
    expect(kvGet(canaryRegistryKey("personal"))).not.toContain(
      exported.artifact.presentedId,
    );
  },
);

it("rejects incorrect real owner proof without creating or downloading a canary", async () => {
  await ceremonyOwner();
  const capture = downloads();
  render(<CanaryCeremony tomb="personal" supported />);
  await ready();
  const before = kvGet(canaryRegistryKey("personal"));
  await perform(
    "Create and export canary",
    "incorrect generated owner password",
  );
  expect(screen.getByRole("status").textContent?.length).toBeGreaterThan(0);
  expect(capture).not.toHaveBeenCalled();
  expect(kvGet(canaryRegistryKey("personal"))).toBe(before);
  expect((await listControlledCanaries("personal")).artifacts).toEqual([]);
});

it("keeps unsupported management disabled with a genuine owner and actual registry", async () => {
  await ceremonyOwner();
  const capture = downloads();
  const loaded = gate();
  canaryUiPorts.load = async () => {
    const api = await original.load();
    return {
      ...api,
      listControlledCanaries: async (tomb) => {
        const status = await api.listControlledCanaries(tomb);
        loaded.release();
        return status;
      },
    };
  };
  render(<CanaryCeremony tomb="personal" supported={false} />);
  await loaded.promise;
  expect(passwordField().disabled).toBe(true);
  expect(button("Create and export canary").disabled).toBe(true);
  fireEvent.click(button("Create and export canary"));
  expect(capture).not.toHaveBeenCalled();
  expect((await listControlledCanaries("personal")).artifacts).toEqual([]);
});

it.each(RETIREMENTS)(
  "withholds an actual completed export across %s without mutating its accepted registry again",
  async (retirement) => {
    const owner = await ceremonyOwner(retirement === "synthetic");
    const capture = downloads();
    const started = gate();
    const held = gate();
    releases.push(held.release);
    let accepted: string | null = null;
    canaryUiPorts.load = async () => {
      const api = await original.load();
      return {
        ...api,
        exportControlledMcpConfiguration: async (input) => {
          const result = await api.exportControlledMcpConfiguration(input);
          accepted = kvGet(canaryRegistryKey("personal"));
          started.release();
          await held.promise;
          return result;
        },
      };
    };
    render(<CanaryCeremony tomb="personal" supported />);
    await ready();
    inputPassword(owner.password);
    await waitFor(() =>
      expect(button("Create and export canary").disabled).toBe(false),
    );
    fireEvent.click(button("Create and export canary"));
    await started.promise;
    expect(accepted).not.toBeNull();
    const completed = await listControlledCanaries("personal");
    expect(completed.artifacts).toHaveLength(1);
    expect(completed.events.map((event) => event.phase)).toEqual([
      "artifact_dispatched",
    ]);
    await act(async () => owner.retire(retirement));
    await releaseGate(held);
    await refused();
    expect(capture).not.toHaveBeenCalled();
    expect(kvGet(canaryRegistryKey("personal"))).toBe(accepted);
    await act(async () => owner.recover());
    expect(await listControlledCanaries("personal")).toEqual(completed);
    canaryUiPorts.load = original.load;
    await perform("Create and export canary", owner.password);
    expect(capture).toHaveBeenCalledTimes(1);
    expect(
      (await listControlledCanaries("personal")).artifacts.map(
        (artifact) => artifact.context.generation,
      ),
    ).toEqual([1, 2]);
  },
);

it.each(RETIREMENTS)(
  "does not start a registry mutation when lazy-loading the actual API crosses %s",
  async (retirement) => {
    const owner = await ceremonyOwner(retirement === "synthetic");
    const capture = downloads();
    render(<CanaryCeremony tomb="personal" supported />);
    await ready();
    const started = gate();
    const held = gate();
    releases.push(held.release);
    canaryUiPorts.load = async () => {
      const api = await original.load();
      started.release();
      await held.promise;
      return api;
    };
    const before = kvGet(canaryRegistryKey("personal"));
    inputPassword(owner.password);
    await waitFor(() =>
      expect(button("Create and export canary").disabled).toBe(false),
    );
    fireEvent.click(button("Create and export canary"));
    await started.promise;
    await act(async () => owner.retire(retirement));
    await releaseGate(held);
    await refused();
    expect(capture).not.toHaveBeenCalled();
    expect(kvGet(canaryRegistryKey("personal"))).toBe(before);
    await act(async () => owner.recover());
    expect((await listControlledCanaries("personal")).artifacts).toEqual([]);
    canaryUiPorts.load = original.load;
    await perform("Create and export canary", owner.password);
    expect(capture).toHaveBeenCalledTimes(1);
    expect((await listControlledCanaries("personal")).artifacts).toHaveLength(
      1,
    );
  },
);
