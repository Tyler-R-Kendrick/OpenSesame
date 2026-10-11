import type { Connection } from "@opensesame/app-core/lib/connections.js";
/** @vitest-environment jsdom */
import { getBundledProviders } from "@opensesame/app-core/lib/embedded-catalog.js";
import { renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router";
import { expect, it } from "vitest";
import {
  connectorIntegration,
  installConnectorIntegration,
} from "../connect/native-connector-integration.test-support.js";
import { makeConnection } from "../section-fixtures.test-support.js";
import { useAiSheet } from "./use-ai-sheet.js";

installConnectorIntegration();

const providers = getBundledProviders();
const live = makeConnection({ providerId: "xai", status: "active" });

type Props = {
  providerId: string | undefined;
  connections: readonly Connection[] | null;
};

function mount(initial: Props) {
  connectorIntegration();
  return renderHook(
    ({ providerId, connections }: Props) =>
      useAiSheet({
        providerId,
        connectionId: undefined,
        pathname: providerId ? `/connections/${providerId}` : "/connections",
        providers,
        connections,
        reload: async () => undefined,
      }),
    {
      initialProps: initial,
      wrapper: ({ children }: { children: ReactNode }) => (
        <MemoryRouter>{children}</MemoryRouter>
      ),
    },
  );
}

it("opens for a provider with no connection once the list has loaded, and not before", () => {
  const view = mount({ providerId: "xai", connections: null });
  expect(view.result.current.target).toBeNull();
  view.rerender({ providerId: "xai", connections: [] });
  expect(view.result.current.target?.provider.id).toBe("xai");
});

it("is the connection's page when one exists", () => {
  const view = mount({ providerId: "xai", connections: [live] });
  expect(view.result.current.target).toBeNull();
});

it("stays on the page when its connection is removed, rather than offering to add it again", () => {
  const view = mount({ providerId: "xai", connections: [live] });
  view.rerender({ providerId: "xai", connections: [] });
  expect(view.result.current.target).toBeNull();
  view.rerender({
    providerId: "xai",
    connections: [{ ...live, status: "revoked" }],
  });
  expect(view.result.current.target).toBeNull();
});

it("decides again on the next arrival, from the catalog or at another provider", () => {
  const view = mount({ providerId: "xai", connections: [live] });
  view.rerender({ providerId: "xai", connections: [] });
  expect(view.result.current.target).toBeNull();
  view.rerender({ providerId: undefined, connections: [] });
  view.rerender({ providerId: "xai", connections: [] });
  expect(view.result.current.target?.provider.id).toBe("xai");
  view.rerender({ providerId: "openai", connections: [] });
  expect(view.result.current.target?.provider.id).toBe("openai");
});
