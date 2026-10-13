plugins {
    kotlin("jvm") version "2.4.10"
    kotlin("plugin.serialization") version "2.4.10"
    application
}

repositories { maven("https://repo.gradle.org/gradle/libs-releases") }

dependencies {
    implementation("org.gradle:gradle-tooling-api:9.6.0")
    runtimeOnly("org.slf4j:slf4j-nop:2.0.17") // stdout é o canal do protocolo; o Tooling API só precisa de um binding.
    implementation("io.github.desodre:adb-utils:0.2.0")
    implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.10.0")
    testImplementation(kotlin("test-junit5"))
    testRuntimeOnly("org.junit.platform:junit-platform-launcher")
}

kotlin { jvmToolchain(17) }
application { mainClass.set("io.github.desodre.androidvscodesupport.MainKt") }
tasks.test { useJUnitPlatform() }
