import type { GuideGoalDescriptor } from "./goals.js";

export const IDENTITY_GOALS: readonly GuideGoalDescriptor[] = [
  {
    id: "identity.account.add",
    title: "Add an account to this deployment",
    routes: [],
    guide: [
      "guide/1",
      'goal "identity.account.add"',
      'say "Accounts are vouched for by an identity provider, so a provider is registered before anyone signs in through it."',
      'navigate "/identity"',
      'wait route "/identity" timeout=15000',
      'focus "identity.providers" "Providers lists whoever may vouch for people here." side=bottom',
      'wait target "identity.register-idp" event=activate timeout=60000',
    ].join("\n"),
  },
  {
    id: "identity.users.manage",
    title: "Manage organization users",
    routes: ["/identity"],
    guide: [
      "guide/1",
      'goal "identity.users.manage"',
      'navigate "/identity"',
      'wait route "/identity" timeout=15000',
      'focus "identity.people" "Open People, select an organization you own, then create or edit a directory user. Provisioning does not replace verified sign-in." side=bottom',
      'wait target "identity.people" event=activate timeout=60000',
    ].join("\n"),
  },
  {
    id: "identity.agents.manage",
    title: "Manage agent registrations",
    routes: ["/identity"],
    guide: [
      "guide/1",
      'goal "identity.agents.manage"',
      'navigate "/identity"',
      'wait route "/identity" timeout=15000',
      'focus "identity.agents" "Open Agents to register a runtime public-key thumbprint, rename a registration or revoke one you own. Never paste a private key." side=bottom',
      'wait target "identity.agents" event=activate timeout=60000',
    ].join("\n"),
  },
];
