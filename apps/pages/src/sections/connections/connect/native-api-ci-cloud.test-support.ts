import {
  type PrimaryContract,
  primaryKey,
} from "./native-api-primary.test-support.js";

export const ciCloudContracts: PrimaryContract[] = [
  {
    id: "buildkite",
    name: "Buildkite",
    origin: "https://api.buildkite.com",
    authorization: `Bearer ${primaryKey}`,
    parameters: { organization_slug: "owned-org" },
    verifyPath: "/v2/access-token",
    readPath: "/v2/organizations/owned-org/pipelines?page=1&per_page=20",
    verifyReply: { uuid: "owned-token" },
    reply: [
      {
        id: "pipeline-owned",
        name: "Release",
        env: { SECRET: "private-env" },
        provider: { webhook_url: "private-webhook" },
      },
    ],
    action: "List pipelines",
    operation: "provider.pipelines.read",
    resultLabel: "Showing 1 pipelines from first page",
  },
  {
    id: "circleci",
    name: "CircleCI",
    origin: "https://circleci.com",
    headers: { "circle-token": primaryKey },
    parameters: { project_slug: "gh/owned/project" },
    verifyPath: "/api/v2/me",
    readPath: "/api/v2/project/gh/owned/project/pipeline",
    verifyReply: { login: "owned-user" },
    reply: {
      items: [
        {
          id: "5034460f-c7c4-4c43-9457-de07e2029e7b",
          number: 25,
          state: "errored",
          project_slug: "gh/owned/project",
          errors: [{ type: "config", message: "private-error" }],
          trigger_parameters: { SECRET: "private-env" },
        },
      ],
      next_page_token: null,
    },
    action: "List project pipelines",
    operation: "provider.pipelines.read",
    resultLabel: "Showing 1 of 1 returned pipelines from first page",
  },
  {
    id: "digitalocean",
    name: "DigitalOcean",
    origin: "https://api.digitalocean.com",
    authorization: `Bearer ${primaryKey}`,
    parameters: {},
    verifyPath: "/v2/account",
    readPath: "/v2/droplets?page=1&per_page=20",
    verifyReply: { account: { email: "owned@example.test" } },
    reply: {
      droplets: [
        {
          id: 3164444,
          name: "web-01",
          networks: { v4: [{ ip_address: "10.0.0.1" }] },
          ssh_keys: ["private-key"],
        },
      ],
      links: { pages: { next: "https://discard.test" } },
      meta: { total: 50 },
    },
    action: "List droplets",
    operation: "provider.droplets.read",
    resultLabel: "Showing 1 non-GPU droplets from first page",
  },
  {
    id: "doppler",
    name: "Doppler",
    origin: "https://api.doppler.com",
    authorization: `Bearer ${primaryKey}`,
    parameters: {},
    verifyPath: "/v3/me",
    readPath: "/v3/projects?page=1&per_page=20",
    verifyReply: { workplace: { name: "Owned" } },
    reply: {
      page: 1,
      projects: [
        {
          id: "ed0c2a68b6",
          name: "Compression",
          slug: "compression",
          description: "private-description",
        },
      ],
    },
    action: "List accessible projects",
    operation: "provider.projects.read",
    resultLabel: "Showing 1 projects from first page",
  },
];
