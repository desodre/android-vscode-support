pluginManagement { repositories { gradlePluginPortal(); mavenCentral() } }
// Provisions the JDK 17 toolchain required by :bridge when the machine has no matching JDK.
plugins { id("org.gradle.toolchains.foojay-resolver-convention") version "1.0.0" }
rootProject.name = "android-vscode-support"
include(":bridge")
