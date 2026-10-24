pluginManagement {
    // Kotlin 2.4 requires R8 >= 9.1.29; override AGP's older embedded compiler.
    buildscript {
        repositories { google(); mavenCentral() }
        dependencies { classpath("com.android.tools:r8:9.1.31") }
    }
    repositories { google(); mavenCentral(); gradlePluginPortal() }
}
dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories { google(); mavenCentral() }
}
rootProject.name = "OpenSesameAuthenticator"
include(":app")
