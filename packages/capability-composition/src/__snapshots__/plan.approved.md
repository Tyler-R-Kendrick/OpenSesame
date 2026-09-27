# capability-composition plan — approved behaviour

planDigest: sha256:76514cb0111e62decf7b72d4db7f962a8d855299b7277c33bf66c0450628d993
instance: fixture-family @ family-r1
selection: selection-1
provenance: same-origin-deployment (policyValid=true)
workerVariant: none
network: allow [https://id.example.test]

## Approved

capabilities: [identity.federation, settings.core, vault.passwords]
modules: [identity.federation/runtime, settings.core/runtime, vault.passwords/runtime]
operations: [pages.identity.signin, pages.items.edit, pages.items.list, pages.settings.prefs.edit]
itemKinds: [login, note]

## Capabilities

- access.authority (optional) axes={distributed,runtimeSupported} via=[connectors.external] reasons=[DENIED_BY_WORKSPACE]
- connectors.external (optional) axes={distributed,permitted,selected,runtimeSupported} via=[] reasons=[DEPENDENCY_CONFLICT]
- identity.federation (optional) axes={distributed,permitted,required,selected,runtimeSupported,approved} via=[sharing.drops] reasons=[]
- notifications.web-push (optional) axes={distributed,permitted,selected} via=[] reasons=[UNSUPPORTED_RUNTIME]
- settings.core (core) axes={distributed,permitted,selected,runtimeSupported,approved} via=[] reasons=[CORE]
- sharing.drops (optional) axes={distributed,permitted,runtimeSupported} via=[sharing.household] reasons=[CONSENT_REQUIRED]
- sharing.household (optional) axes={distributed,permitted,selected,runtimeSupported} via=[] reasons=[CONSENT_REQUIRED]
- sharing.local-transport (optional) axes={distributed,permitted} via=[] reasons=[UNSUPPORTED_RUNTIME, NOT_SELECTED]
- support.local-ai (optional) axes={distributed,permitted} via=[] reasons=[UNSUPPORTED_RUNTIME, NOT_SELECTED]
- telemetry.external (optional) axes={distributed,selected,runtimeSupported} via=[] reasons=[PROHIBITED_BY_INSTANCE]
- vault.passkey-records (optional) axes={distributed,selected,runtimeSupported} via=[] reasons=[DENIED_BY_WORKSPACE]
- vault.passwords (core) axes={distributed,permitted,selected,runtimeSupported,approved} via=[] reasons=[CORE]

## Conflicts

! connectors.external DEPENDENCY_NOT_PERMITTED access.authority

## Consent owed

addedRoots: [sharing.household]
removedRoots: []
changedExposure: []
addedDependencies: [sharing.drops]
requiredNotAccepted: []
