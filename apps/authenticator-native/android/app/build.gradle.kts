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

android {
    namespace = "dev.opensesame.authenticator"
    compileSdk = 36

    defaultConfig {
        applicationId = "dev.opensesame.authenticator"
        minSdk = 29
        targetSdk = 36
        versionCode = 1
        versionName = "0.1.0"
        manifestPlaceholders["opensesameInvocationHost"] = invocationHost
        buildConfigField("String", "INVOCATION_HOST", "\"$invocationHost\"")
        buildConfigField(
            "String",
            "WALLET_BACKEND_URL",
            "\"${providers.gradleProperty("opensesameWalletBackendUrl").orNull ?: ""}\"",
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
}

dependencies {
    implementation("net.java.dev.jna:jna:5.18.1@aar")
    implementation("org.multipaz:multipaz:0.100.0")
    implementation("org.multipaz:multipaz-compose:0.100.0")
    implementation("org.multipaz:multipaz-doctypes:0.100.0")
    implementation("org.multipaz:multipaz-cbor-rpc:0.100.0")
    implementation("androidx.activity:activity-compose:1.11.0")
    implementation("androidx.fragment:fragment-ktx:1.8.9")
    implementation("io.ktor:ktor-client-android:3.3.1")
    testImplementation("junit:junit:4.13.2")
}
