import Multipaz

/// Explicit equivalents of Multipaz 0.100.0's Kotlin default arguments, which Swift cannot call.
func defaultProvisioningSettings() -> DocumentProvisioningSettings {
    DocumentProvisioningSettings(
        minValidTime: KotlinDurationCompanion.shared.days(Int32(5)),
        keyBoundCredentialMaxUses: 1,
        keyBoundCredentialNumPerDomain: 5,
        keylessCredentialMaxUses: Int32.max,
        keylessCredentialNumPerDomain: 1,
        userAuthTimeout: KotlinDurationCompanion.shared.ZERO,
        requestUserAuth: true,
        requestNoUserAuth: true,
        mdocUserAuthDomain: "mdoc_user_auth",
        mdocNoUserAuthDomain: "mdoc_no_user_auth",
        sdJwtUserAuthDomain: "sdjwt_user_auth",
        sdJwtNoUserAuthDomain: "sdjwt_no_user_auth",
        sdJwtKeylessDomain: "sdjwt_keyless"
    )
}
