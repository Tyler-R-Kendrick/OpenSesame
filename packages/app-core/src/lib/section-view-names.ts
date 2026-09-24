/** The Access and Identity tab names shared by routes, trees and browser tools. */
export const ACCESS_VIEWS = [
  "grants",
  "requests",
  "sessions",
  "connectors",
  "resources",
  "policies",
] as const;
export const ACCESS_LABELS = {
  grants: "Grants",
  requests: "Requests",
  sessions: "Sessions",
  connectors: "Connectors",
  resources: "Resources",
  policies: "Policies",
} satisfies Record<(typeof ACCESS_VIEWS)[number], string>;
export const IDENTITY_VIEWS = [
  "people",
  "agents",
  "providers",
  "devices",
  "service-accounts",
  "organization",
] as const;
export const IDENTITY_LABELS = {
  people: "People",
  agents: "Agents",
  providers: "Providers",
  devices: "Devices",
  "service-accounts": "Applications",
  organization: "Organizations",
} satisfies Record<(typeof IDENTITY_VIEWS)[number], string>;
