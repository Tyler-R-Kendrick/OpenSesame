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
  "target:vault.filter": "no tutorial points at it yet",
  "target:vault.filter.favorites": "no tutorial points at it yet",
  "target:vault.filter.logins": "no tutorial points at it yet",
  "target:vault.health.findings": "no tutorial points at it yet",
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
  "target:vaults.list": "no tutorial points at it yet",
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
  "key:listing.next": "no tutorial teaches this key yet",
  "key:listing.previous": "no tutorial teaches this key yet",
  "key:listing.first": "no tutorial teaches this key yet",
  "key:listing.last": "no tutorial teaches this key yet",
  "key:listing.high": "no tutorial teaches this key yet",
  "key:listing.mid": "no tutorial teaches this key yet",
  "key:listing.low": "no tutorial teaches this key yet",
  "key:listing.half-down": "no tutorial teaches this key yet",
  "key:listing.half-up": "no tutorial teaches this key yet",
  "key:listing.page-down": "no tutorial teaches this key yet",
  "key:listing.page-up": "no tutorial teaches this key yet",
  "key:listing.dive": "no tutorial teaches this key yet",
  "key:listing.climb": "no tutorial teaches this key yet",
  "key:listing.search": "no tutorial teaches this key yet",
  "key:command.palette": "no tutorial teaches this key yet",
  "key:help.keymap": "no tutorial teaches this key yet",
  "key:voice.toggle": "no tutorial teaches this key yet",
  "key:item.copy-secret": "no tutorial teaches this key yet",
  "key:item.copy-username": "no tutorial teaches this key yet",
  "key:item.edit": "no tutorial teaches this key yet",
  "key:item.new": "no tutorial teaches this key yet",
  "key:item.favorite": "no tutorial teaches this key yet",
  "key:item.trash": "no tutorial teaches this key yet",
  "key:item.share": "no tutorial teaches this key yet",
  "key:item.restore": "no tutorial teaches this key yet",
  "key:item.purge": "no tutorial teaches this key yet",
  "key:register.record": "no tutorial teaches this key yet",
  "key:register.replay": "no tutorial teaches this key yet",
};
