import { cleanup, fireEvent, render, screen } from "@testing-library/react";
/** @vitest-environment jsdom */
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it } from "vitest";
import type { Connection } from "../../lib/connections.js";
import { ConnectedPanel } from "./ConnectedPanel.js";
import { CONNECTIONS_PAGE_SIZE } from "./page-cap.js";
import { declareConnectionsTutorial } from "./tutorial.test-support.js";

/**
 * What the Connected panel says when it has nothing to say.
 *
 * A unit test rather than a walk through the whole section, because the answer
 * is decided entirely by props: with no Host configured the section never asks
 * for connections, so `connections` stays null with `loading` false — the state
 * that used to render "Connections could not be read.", a report of a failure
 * that never happened (ADR 0090 §7).
 */

interface PanelOverrides {
  hostConfigured: boolean;
  loading?: boolean;
  connections?: Connection[] | null;
}
function connection(index: number): Connection {
  return {
    connectionId: `conn_${index}`,
    connectionRef: `ref_${index}`,
    logicalName: `svc-${index}`,
    displayName: `Service ${index}`,
    providerId: "github",
    integrationId: null,
    status: "active",
    statusDetail: null,
    organizationId: "org",
    projectId: null,
    ownerKind: "user",
    shareability: "private",
    requestedScopes: [],
    grantedScopes: [],
    accountLabel: null,
    expiresAt: null,
    refreshable: false,
    lastRefreshedAt: null,
    maxInvokeLevel: 0,
    egress: { scheme: "https", authorities: [], pathPrefixes: [] },
    bindings: [],
    createdAt: "2026-09-01T00:00:00Z",
    updatedAt: "2026-09-01T00:00:00Z",
  };
}

function renderPanel(over: PanelOverrides) {
  return render(
    <MemoryRouter>
      <ConnectedPanel
        connections={over.connections === undefined ? null : over.connections}
        providers={[]}
        loading={over.loading ?? false}
        setupRequired={false}
        hostConfigured={over.hostConfigured}
      />
    </MemoryRouter>,
  );
}

// The panel mounts `connections.connected`, a guide target
// `connectors.external` contributes; these cases describe a deployment
// that approved it.
declareConnectionsTutorial();

describe("ConnectedPanel with no Host", () => {
  afterEach(cleanup);

  it("treats a missing Host as empty, not a failed read", () => {
    renderPanel({ hostConfigured: false });
    expect(screen.getByText("Nothing connected")).toBeTruthy();
    expect(screen.queryByText("No Host connected")).toBeNull();
    expect(screen.queryByText("Connections could not be read.")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("still reports a real read failure where a Host was asked", () => {
    // With a Host configured, a null list after loading finished IS a failed
    // read, and the panel must keep saying so.
    renderPanel({ hostConfigured: true });
    expect(screen.getByText("Connections could not be read.")).toBeTruthy();
    expect(screen.queryByText("No Host connected")).toBeNull();
  });

  it("says it is still reading while a configured Host is being asked", () => {
    renderPanel({ hostConfigured: true, loading: true });
    expect(screen.getByText("Reading connections…")).toBeTruthy();
  });
});

describe("ConnectedPanel page cap", () => {
  afterEach(cleanup);

  it("shows the nav page cap, then loads another page on request", () => {
    const rows = Array.from({ length: CONNECTIONS_PAGE_SIZE + 5 }, (_, index) =>
      connection(index + 1),
    );
    renderPanel({ hostConfigured: true, connections: rows });
    expect(screen.getAllByRole("heading", { level: 3 })).toHaveLength(
      CONNECTIONS_PAGE_SIZE,
    );
    expect(screen.getByText("Service 1")).toBeTruthy();
    expect(screen.queryByText("Service 13")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Load 5 more" }));
    expect(screen.getByText("Service 17")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Load \d+ more/ })).toBeNull();
  });
});
