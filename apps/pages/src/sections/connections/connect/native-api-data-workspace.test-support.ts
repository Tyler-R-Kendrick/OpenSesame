import {
  type PrimaryContract,
  primaryKey,
} from "./native-api-primary.test-support.js";

export const dataWorkspaceContracts: PrimaryContract[] = [
  {
    id: "neon",
    name: "Neon",
    origin: "https://console.neon.tech",
    authorization: `Bearer ${primaryKey}`,
    parameters: { org_id: "org-spring-garden-12345" },
    verifyPath: "/api/v2/projects?limit=20&org_id=org-spring-garden-12345",
    readPath: "/api/v2/projects?limit=20&org_id=org-spring-garden-12345",
    verifyReply: { projects: [] },
    reply: {
      projects: [
        {
          id: "project-owned",
          name: "Production",
          org_id: "org-spring-garden-12345",
          connection_uri: "private-connection",
        },
      ],
      pagination: { cursor: "opaque" },
    },
    action: "List projects",
    operation: "provider.projects.read",
    resultLabel: "Showing 1 projects from first page",
  },
  {
    id: "pinecone",
    name: "Pinecone",
    origin: "https://api.pinecone.io",
    headers: { "api-key": primaryKey, "x-pinecone-api-version": "2025-04" },
    parameters: {},
    verifyPath: "/indexes",
    readPath: "/indexes",
    verifyReply: { indexes: [] },
    reply: {
      indexes: [
        {
          name: "owned-index",
          host: "private-webhook",
          embed: { model: "private-key" },
        },
      ],
    },
    action: "List indexes",
    operation: "provider.indexes.read",
    resultLabel: "Showing 1 of 1 returned indexes",
  },
  {
    id: "n8n",
    name: "n8n",
    origin: "https://owned-workflows.app.n8n.cloud",
    headers: { "x-n8n-api-key": primaryKey },
    parameters: { instance: "owned-workflows" },
    verifyPath: "/api/v1/workflows?limit=1",
    readPath: "/api/v1/workflows?limit=20&excludePinnedData=true",
    verifyReply: { data: [], nextCursor: null },
    reply: {
      data: [
        {
          id: "workflow-owned",
          name: "Release",
          nodes: [{ credentials: { secret: "private-key" } }],
          pinData: { token: "private-pinned" },
        },
      ],
      nextCursor: "opaque",
    },
    action: "List workflows",
    operation: "provider.workflows.read",
    resultLabel: "Showing 1 workflows from first page",
  },
  {
    id: "mailgun",
    name: "Mailgun",
    origin: "https://api.eu.mailgun.net",
    authorization: `Basic ${btoa(`api:${primaryKey}`)}`,
    parameters: { api_host: "api.eu.mailgun.net" },
    verifyPath: "/v4/domains?limit=20&skip=0",
    readPath: "/v4/domains?limit=20&skip=0",
    verifyReply: { items: [], total_count: 0 },
    reply: {
      items: [
        {
          id: "domain-owned",
          name: "mail.example.test",
          smtp_password: "private-smtp",
          archive_to: "private-webhook",
        },
      ],
      total_count: 1,
    },
    action: "List domains",
    operation: "provider.domains.read",
    resultLabel: "Showing 1 domains from first page",
  },
];
