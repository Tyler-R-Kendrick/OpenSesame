/** @vitest-environment jsdom */
/** @vitest-environment-options {"url":"https://selfhost.example/"} */
import {
  type Connection,
  listConnections,
} from "@opensesame/app-core/lib/connections.js";
import { readDeviceRows } from "@opensesame/app-core/lib/device-connector-records.js";
import {
  forgetAllLocalGitRemotes,
  rememberLocalGitRemote,
} from "@opensesame/app-core/lib/git-remote-local.js";
import { readNativeConnector } from "@opensesame/app-core/lib/native-connector-store.js";
import { configureNativeGithubPersonal } from "@opensesame/app-core/lib/native-github-personal.js";
import { configureNativeS3 } from "@opensesame/app-core/lib/native-s3.js";
import { deferred } from "@opensesame/app-core/lib/secret-backends/runtime.test-support.js";
import { act, render, screen, waitFor } from "@testing-library/react";
import { useEffect } from "react";
import { MemoryRouter } from "react-router";
import { afterEach, expect, it, vi } from "vitest";
import { bindNativeCleanupRuntime } from "../../../modules/connectors.external/native-cleanup-runtime.js";
import { ConnectedPanel } from "../ConnectedPanel.js";
import { nativeConnectorController } from "../connect/native-connector-controller.js";
import {
  connectorIntegration,
  installConnectorIntegration,
} from "../connect/native-connector-integration.test-support.js";
import { declareConnectionsTutorial } from "../tutorial.test-support.js";
import {
  currentTailscaleConnections,
  useTailscaleConnections,
} from "./useTailscaleConnectionState.js";

declareConnectionsTutorial();
installConnectorIntegration();
afterEach(() => forgetAllLocalGitRemotes());
const signingKey = "private-native-projection-signing-key";
const githubKey = "github_pat_private_projection_key";
type Fixture = ReturnType<typeof connectorIntegration>;

function protocolFixture() {
  const fixture = connectorIntegration();
  bindNativeCleanupRuntime(fixture.activation, ["s3", "github"]);
  fixture.route.respond = async (request) => {
    const url = new URL(request.url);
    expect(request.method).toBe("GET");
    if (url.origin === "https://api.github.com") {
      expect(url.pathname).toBe("/user");
      expect(request.headers.get("Authorization")).toBe(`Bearer ${githubKey}`);
      return Response.json({ id: 12345, login: "octocat", type: "User" });
    }
    expect(url.origin).toBe("https://minio.example.test");
    expect(url.searchParams.get("list-type")).toBe("2");
    expect(request.headers.get("Authorization")).toMatch(/^AWS4-HMAC-SHA256 /);
    return new Response(
      `<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Name>test-bucket</Name><Prefix/><IsTruncated>false</IsTruncated></ListBucketResult>`,
    );
  };
  return fixture;
}

function configureBucket(name: string, connectionId?: string) {
  return configureNativeS3({
    providerId: "s3",
    displayName: name,
    connectionId,
    revision: connectionId
      ? readNativeConnector(connectionId)?.revision
      : undefined,
    parameters: {
      endpoint: "https://minio.example.test",
      region: "us-east-1",
      bucket: "test-bucket",
      access_key_id: "projection-access-key",
    },
    credentials: { secret_access_key: signingKey },
  });
}

function configureGithub() {
  return configureNativeGithubPersonal({
    providerId: "github",
    displayName: "Retained GitHub",
    parameters: {},
    credentials: { api_key: githubKey },
  });
}

function Projection({
  load = listConnections,
}: { load?: () => Promise<Connection[]> }) {
  const [connections, setConnections] = useTailscaleConnections();
  useEffect(() => {
    let live = true;
    void load().then((rows) => {
      if (live) setConnections(currentTailscaleConnections(rows));
    });
    return () => {
      live = false;
    };
  }, [load, setConnections]);
  return (
    <>
      <output aria-label="Projection loaded">
        {connections === null ? "no" : "yes"}
      </output>
      <ConnectedPanel
        connections={connections}
        providers={[]}
        loading={connections === null}
        setupRequired={false}
      />
    </>
  );
}

function mountProjection(load?: () => Promise<Connection[]>) {
  return render(
    <MemoryRouter>
      <Projection load={load} />
    </MemoryRouter>,
  );
}

async function removeActual(id: string, providerId: string) {
  const controller = nativeConnectorController(
    { id: providerId, refused: false },
    id,
  );
  expect(controller.load()?.status).toBe("connected");
  await controller.remove();
  expect(controller.load()).toBeNull();
  expect(readNativeConnector(id)).toBeNull();
}

function expectCiphertext(fixture: Fixture) {
  for (const credential of [signingKey, githubKey]) {
    expect(JSON.stringify(readDeviceRows())).not.toContain(credential);
    expect([...fixture.disk.files.values()].join()).not.toContain(credential);
  }
}

it("projects committed native S3 revisions without a second list or provider probe", async () => {
  const fixture = protocolFixture();
  const saved = await configureBucket("Original bucket");
  expect(saved.connectionId).toMatch(/^conn_s3_/);
  const load = vi.fn(listConnections);
  mountProjection(load);
  await screen.findByRole("heading", { name: "Original bucket" });
  await act(async () => {
    await configureBucket("Updated bucket", saved.connectionId);
  });
  expect(readNativeConnector(saved.connectionId)?.revision).toBeGreaterThan(
    saved.revision,
  );
  await screen.findByRole("heading", { name: "Updated bucket" });
  expect(screen.queryByRole("heading", { name: "Original bucket" })).toBeNull();
  expect(load).toHaveBeenCalledOnce();
  expect(fixture.requests).toHaveLength(2);
  expectCiphertext(fixture);
});

it("adds a different native provider from its committed device event", async () => {
  const fixture = protocolFixture();
  const load = vi.fn(listConnections);
  mountProjection(load);
  await waitFor(() =>
    expect(screen.getByLabelText("Projection loaded").textContent).toBe("yes"),
  );
  await act(async () => {
    await configureGithub();
  });
  await screen.findByRole("heading", { name: "Retained GitHub" });
  expect(load).toHaveBeenCalledOnce();
  expect(fixture.requests).toHaveLength(1);
  expectCiphertext(fixture);
});

it("removes the actual native tombstone while retaining native B and local Git", async () => {
  const fixture = protocolFixture();
  const saved = await configureBucket("Removed bucket");
  await configureGithub();
  await rememberLocalGitRemote({
    displayName: "Retained local Git",
    configuration: {
      remote_url: "ssh://git@git.example/repo.git",
      auth_mode: "ssh_agent",
    },
  });
  const load = vi.fn(listConnections);
  mountProjection(load);
  await screen.findByRole("heading", { name: "Removed bucket" });
  await act(async () => {
    await removeActual(saved.connectionId, "s3");
  });
  await waitFor(() =>
    expect(
      screen.queryByRole("heading", { name: "Removed bucket" }),
    ).toBeNull(),
  );
  expect(screen.getByRole("heading", { name: "Retained GitHub" })).toBeTruthy();
  expect(
    screen.getByRole("heading", { name: "Retained local Git" }),
  ).toBeTruthy();
  expect(load).toHaveBeenCalledOnce();
  expect(fixture.requests).toHaveLength(2);
  expectCiphertext(fixture);
  const rows = await fixture.reload();
  expect(rows.some((row) => row.connectionId === saved.connectionId)).toBe(
    false,
  );
});

it("reprojects a held actual list after removal and preserves an imported ID collision", async () => {
  const fixture = protocolFixture();
  const saved = await configureBucket("Removed from old list");
  const captured = deferred<void>();
  const release = deferred<void>();
  let snapshot: Connection[] = [];
  const load = async () => {
    snapshot = await listConnections();
    captured.resolve();
    await release.promise;
    return snapshot;
  };
  mountProjection(load);
  await captured.promise;
  expect(snapshot.map((row) => row.connectionId)).toContain(saved.connectionId);
  expect(screen.getByLabelText("Projection loaded").textContent).toBe("no");
  await act(async () => {
    await removeActual(saved.connectionId, "s3");
  });
  expect(screen.getByLabelText("Projection loaded").textContent).toBe("no");
  await act(async () => {
    release.resolve();
  });
  await waitFor(() =>
    expect(screen.getByLabelText("Projection loaded").textContent).toBe("yes"),
  );
  expect(
    screen.queryByRole("heading", { name: "Removed from old list" }),
  ).toBeNull();
  expect(
    screen.getByRole("heading", { name: "Nothing connected" }),
  ).toBeTruthy();
  const previous = snapshot.find(
    (row) => row.connectionId === saved.connectionId,
  );
  if (!previous) throw new Error("Missing actual captured native connection");
  const imported = { ...previous, connectionRef: "imported/retained" };
  expect(currentTailscaleConnections([...snapshot, imported])).toEqual([
    imported,
  ]);
  expect(currentTailscaleConnections(null)).toBeNull();
  expect(fixture.requests).toHaveLength(1);
  expectCiphertext(fixture);
});
