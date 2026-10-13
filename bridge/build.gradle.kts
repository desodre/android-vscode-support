plugins {
    kotlin("jvm") version "2.4.10"
    kotlin("plugin.serialization") version "2.4.10"
    application
}

dependencies {
    implementation("io.github.desodre:adb-utils:0.2.0")
    implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.10.0")
    testImplementation(kotlin("test-junit5"))
    testRuntimeOnly("org.junit.platform:junit-platform-launcher")
}

kotlin { jvmToolchain(17) }
application { mainClass.set("io.github.desodre.androidvscodesupport.MainKt") }
tasks.test { useJUnitPlatform() }
