import java.net.URI

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
}

val invocationHost = providers.gradleProperty("opensesameInvocationHost").orNull
    ?: "auth.opensesame.dev"
require(invocationHost.matches(Regex("[A-Za-z0-9.-]+"))) {
    "opensesameInvocationHost must be a DNS hostname"
}
val walletBackend = providers.gradleProperty("opensesameWalletBackendUrl").orNull ?: ""
if (walletBackend.isNotEmpty()) {
    val endpoint = URI(walletBackend)
    require(endpoint.scheme == "https" && endpoint.host != null && endpoint.userInfo == null
        && endpoint.fragment == null && endpoint.query == null) {
        "opensesameWalletBackendUrl must be an HTTPS endpoint without credentials, query or fragment"
    }
}
val signingValues = listOf("OPENSESAME_ANDROID_KEYSTORE", "OPENSESAME_ANDROID_KEYSTORE_PASSWORD",
    "OPENSESAME_ANDROID_KEY_ALIAS", "OPENSESAME_ANDROID_KEY_PASSWORD")
    .map { providers.environmentVariable(it).orNull }

android {
    namespace = "dev.opensesame.authenticator"
    compileSdk = 36

    defaultConfig {
        applicationId = "dev.opensesame.authenticator"
        minSdk = 29
        targetSdk = 36
        versionCode = 1
        versionName = "0.1.0"
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
        manifestPlaceholders["opensesameInvocationHost"] = invocationHost
        buildConfigField("String", "INVOCATION_HOST", "\"$invocationHost\"")
        buildConfigField(
            "String",
            "WALLET_BACKEND_URL",
            "\"$walletBackend\"",
        )
    }
    buildFeatures { compose = true; buildConfig = true }
    sourceSets["main"].java.srcDir("../../generated/kotlin")
    sourceSets["main"].jniLibs.srcDir("../../generated/android/jniLibs")
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
    if (signingValues.all { !it.isNullOrEmpty() }) {
        signingConfigs.create("production") {
            storeFile = file(signingValues[0]!!)
            storePassword = signingValues[1]
            keyAlias = signingValues[2]
            keyPassword = signingValues[3]
        }
        buildTypes.getByName("release").signingConfig = signingConfigs.getByName("production")
    }
}

val verifyReleaseConfiguration = tasks.register("verifyReleaseConfiguration") {
    doLast {
        require(signingValues.all { !it.isNullOrEmpty() }) {
            "Production Android packaging requires all four OPENSESAME_ANDROID signing inputs"
        }
        require(file(signingValues[0]!!).isFile) { "Production Android keystore is unavailable" }
        require(walletBackend.isNotEmpty() && !URI(walletBackend).host.lowercase().endsWith(".invalid")) {
            "Production Android packaging requires the configured production HTTPS wallet backend"
        }
    }
}
tasks.matching { it.name in setOf("packageRelease", "assembleRelease", "bundleRelease", "packageReleaseBundle") }
    .configureEach { dependsOn(verifyReleaseConfiguration) }

dependencies {
    implementation("net.java.dev.jna:jna:5.18.1@aar")
    implementation("org.multipaz:multipaz:0.100.0")
    implementation("org.multipaz:multipaz-compose:0.100.0")
    implementation("org.multipaz:multipaz-doctypes:0.100.0")
    implementation("org.multipaz:multipaz-cbor-rpc:0.100.0")
    implementation("androidx.activity:activity-compose:1.11.0")
    implementation("androidx.fragment:fragment-ktx:1.8.9")
    implementation("androidx.biometric:biometric:1.1.0")
    implementation("io.ktor:ktor-client-android:3.3.1")
    implementation("io.ktor:ktor-client-okhttp:3.3.1")
    testImplementation("junit:junit:4.13.2")
    // JVM tests execute the generated Kotlin FFI against the real host Rust
    // library; the ordinary JNA jar supplies Linux/macOS jnidispatch resources.
    testImplementation("net.java.dev.jna:jna:5.18.1")
    androidTestImplementation("androidx.test.ext:junit:1.3.0")
    androidTestImplementation("androidx.test:runner:1.7.0")
    androidTestImplementation("androidx.test.uiautomator:uiautomator:2.3.0")
    androidTestImplementation("androidx.compose.ui:ui-test-junit4:1.10.2")
}

tasks.withType<Test>().configureEach {
    val nativeHost = providers.environmentVariable("OPENSESAME_NATIVE_HOST_LIBRARY_DIR")
    if (nativeHost.isPresent) {
        systemProperty("jna.library.path", nativeHost.get())
        // A Rust implementation change can leave generated Kotlin unchanged.
        // Include the actual dynamic library in Gradle's test cache key.
        inputs.files(fileTree(nativeHost.get()) {
            include("libopensesame_authenticator_core.so", "libopensesame_authenticator_core.dylib", "opensesame_authenticator_core.dll")
        }).withPropertyName("nativeAuthenticatorLibrary")
            .withPathSensitivity(PathSensitivity.RELATIVE)
    }
}
