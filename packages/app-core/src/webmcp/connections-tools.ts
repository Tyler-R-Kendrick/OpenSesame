/**
 * Vercel Connect connection tools — the read view and the consent-ceremony
 * opener. Owned by `connectors.external`; contributed as `webmcp-tool`
 * entries by that capability's runtime, never by `agents.webmcp` itself, so
 * the connection client is not loaded when connectors are not approved.
 */

import { getConnection, listConnections } from "../lib/connections.js";
import {
  type PagesWebMcpTool,
  ceremonyOpened,
  optStr,
  str,
} from "./tool-shared.js";

export const CONNECTIONS_READ_TOOL: PagesWebMcpTool = {
  name: "opensesame_connections_read",
  capabilityIds: ["connections.list", "connections.inspect"],
  scope: "session",
  readOnly: true,
  description:
    "Read Vercel Connect connections: the list, or one connection. Read-only; never returns credentials.",
  inputSchema: {
    type: "object",
    properties: {
      view: {
        type: "string",
        enum: ["connections", "connection"],
      },
      connectionId: {
        type: "string",
        description: "Required for the connection view.",
      },
    },
    required: ["view"],
    additionalProperties: false,
  },
  execute: async (args) => {
    const view = str(args, "view");
    switch (view) {
      case "connections":
        return { connections: await listConnections() };
      case "connection": {
        const id = str(args, "connectionId");
        const connection = await getConnection(id);
        return { connection };
      }
      default:
        throw new Error(`unknown_view:${view}`);
    }
  },
};

export const OPEN_CONNECT_CEREMONY_TOOL: PagesWebMcpTool = {
  name: "opensesame_open_connect_ceremony",
  capabilityIds: ["connections.create", "connections.bindings"],
  scope: "session",
  description:
    "Open the connect ceremony for a provider (and optionally an existing connection) so the human can grant consent. Never completes the ceremony.",
  inputSchema: {
    type: "object",
    properties: {
      providerId: { type: "string" },
      connectionId: { type: "string" },
    },
    additionalProperties: false,
  },
  execute: (args) => {
    const provider = optStr(args, "providerId");
    const connection = optStr(args, "connectionId");
    let location = "/connections";
    if (provider) {
      location += `/${encodeURIComponent(provider)}`;
      if (connection) location += `/${encodeURIComponent(connection)}`;
    }
    return ceremonyOpened(location);
  },
};
