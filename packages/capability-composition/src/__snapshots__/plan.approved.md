# capability-composition plan — approved behaviour

planDigest: cf6fe1c38dcf7a01
canonicalDigest: 8cf73918b4d06529

- core.audit [not-loaded] axes={permitted,selected,availableInDistribution,consented} reasons=[UNSUPPORTED_RUNTIME]
- core.fill [active] axes={permitted,selected,availableInDistribution,supportedByRuntime,consented,loaded} reasons=[]
- core.share [not-loaded] axes={selected,availableInDistribution,supportedByRuntime} reasons=[DENIED_BY_WORKSPACE]
! core.audit UNSUPPORTED_RUNTIME (runtime): needs one of service-worker
! core.share DENIED_BY_WORKSPACE (instance-policy+vault-restriction.allow): not in the explicit allow set
? consent core.share required=true granted=false
