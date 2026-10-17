plugins {
    id("com.android.application")
}

android {
    namespace = "io.github.desodre.editingfixture"
    compileSdk = 35

    defaultConfig {
        applicationId = "io.github.desodre.editingfixture"
        minSdk = 23
        targetSdk = 35
    }

    flavorDimensions += "tier"
    productFlavors {
        create("free") { dimension = "tier" }
        create("paid") { dimension = "tier" }
    }

    buildFeatures { buildConfig = true }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

androidComponents {
    onVariants(selector().withName("freeDebug")) { variant ->
        variant.sources.java?.addStaticSourceDirectory("custom/free/java")
    }
}

dependencies {
    implementation(project(":fixture"))
    testImplementation("junit:junit:4.13.2")
}
