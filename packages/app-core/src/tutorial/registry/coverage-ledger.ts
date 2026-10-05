/**
 * The debt ledger of tutorial coverage (ADR 0163 §6).
 *
 * Every control a guide can point at (`target:<id>`) and every key the keymap
 * binds (`key:<command id>`) is taught by a tutorial, or it is named here with
 * the reason it is not. \`coverage.test.ts\` fails on a control with neither, on
 * an entry that a tutorial now covers, and on an entry whose control is gone,
 * so this list only falls: teaching a control means deleting its line.
 *
 * A reason says what is missing. It is never a way to leave a control out:
 * "not worth a tutorial" is not a reason.
 */
export const COVERAGE_EXEMPT: Readonly<Record<string, string>> = {
  "target:nav.menu": "no tutorial points at it yet",
  "target:nav.vault": "no tutorial points at it yet",
  "target:nav.settings": "no tutorial points at it yet",
  "target:shell.notifications": "no tutorial points at it yet",
  "target:shell.connectivity": "no tutorial points at it yet",
  "target:feature.backups": "no tutorial points at it yet",
  "target:feature.notifications": "no tutorial points at it yet",
  "target:feature.local-notifications": "no tutorial points at it yet",
  "target:settings.general": "no tutorial points at it yet",
  "target:settings.keybindings": "no tutorial points at it yet",
  "target:settings.connectivity": "no tutorial points at it yet",
  "target:settings.sops-document": "no tutorial points at it yet",
  "target:settings.recovery": "no tutorial points at it yet",
  "target:settings.capabilities": "no tutorial points at it yet",
  "target:settings.vaults": "no tutorial points at it yet",
  "target:settings.data": "no tutorial points at it yet",
  "target:settings.danger": "no tutorial points at it yet",
  "target:settings.auto-lock": "no tutorial points at it yet",
  "target:notifications.health": "no tutorial points at it yet",
  "target:unlock.submit":
    "a gate screen: its tour needs the gate help launcher (ADR 0165)",
  "target:unlock.secret":
    "a gate screen: its tour needs the gate help launcher (ADR 0165)",
  "target:unlock.passkey":
    "a gate screen: its tour needs the gate help launcher (ADR 0165)",
  "target:unlock.account":
    "a gate screen: its tour needs the gate help launcher (ADR 0165)",
  "target:unlock.signin":
    "a gate screen: its tour needs the gate help launcher (ADR 0165)",
  "target:unlock.setup":
    "a gate screen: its tour needs the gate help launcher (ADR 0165)",
  "target:setup.join":
    "a gate screen: its tour needs the gate help launcher (ADR 0165)",
  "target:setup.ways":
    "a gate screen: its tour needs the gate help launcher (ADR 0165)",
  "target:setup.connectors":
    "a gate screen: its tour needs the gate help launcher (ADR 0165)",
  "target:setup.keep":
    "a gate screen: its tour needs the gate help launcher (ADR 0165)",
  "target:setup.finish":
    "a gate screen: its tour needs the gate help launcher (ADR 0165)",
  "target:broker.consent":
    "a gate screen: its tour needs the gate help launcher (ADR 0165)",
  "target:federation.return":
    "a gate screen: its tour needs the gate help launcher (ADR 0165)",
  "target:settings.live-session": "no tutorial points at it yet",
  "target:settings.live-routes": "no tutorial points at it yet",
  "target:access.grants": "no tutorial points at it yet",
  "target:access.policies": "no tutorial points at it yet",
  "target:access.relay": "no tutorial points at it yet",
  "target:access.resources": "no tutorial points at it yet",
  "target:connections.attention": "no tutorial points at it yet",
  "target:connections.back": "no tutorial points at it yet",
  "target:connections.bindings": "no tutorial points at it yet",
  "target:connections.catalog": "no tutorial points at it yet",
  "target:connections.reload": "no tutorial points at it yet",
  "target:connections.renew": "no tutorial points at it yet",
  "target:connections.revoke": "no tutorial points at it yet",
  "target:identity.claim-access": "no tutorial points at it yet",
  "target:identity.org-signin": "no tutorial points at it yet",
  "target:identity.organization": "no tutorial points at it yet",
  "target:identity.service-accounts": "no tutorial points at it yet",
  "target:nav.access": "no tutorial points at it yet",
  "target:nav.activity": "no tutorial points at it yet",
  "target:nav.connections": "no tutorial points at it yet",
  "target:nav.identity": "no tutorial points at it yet",
  "target:nav.wallet": "no tutorial points at it yet",
  "target:settings.browser-autofill": "no tutorial points at it yet",
  "target:settings.surrogate-credentials": "no tutorial points at it yet",
  "key:section.vault": "no tutorial teaches this key yet",
  "key:section.settings": "no tutorial teaches this key yet",
};
