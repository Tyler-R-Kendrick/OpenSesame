buildscript {
    // Patched versions for the Android plugin's build-only dependencies.
    dependencies {
        classpath(platform("io.netty:netty-bom:4.1.139.Final"))
        constraints {
            add("classpath", "org.bouncycastle:bcprov-jdk18on:1.86")
            add("classpath", "org.bouncycastle:bcpkix-jdk18on:1.86")
            add("classpath", "org.bouncycastle:bcutil-jdk18on:1.86")
            add("classpath", "org.apache.commons:commons-compress:1.28.0")
            add("classpath", "org.bitbucket.b_c:jose4j:0.9.7")
            add("classpath", "org.jdom:jdom2:2.0.6.1")
        }
    }
}

plugins {
    id("com.android.application") version "8.13.1" apply false
    id("org.jetbrains.kotlin.android") version "2.4.20" apply false
    id("org.jetbrains.kotlin.plugin.compose") version "2.4.20" apply false
}
