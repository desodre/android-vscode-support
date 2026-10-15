plugins {
    id("com.android.application")
}

android {
    namespace = "io.github.desodre.debugfixture"
    compileSdk = 35

    defaultConfig {
        applicationId = "io.github.desodre.debugfixture"
        minSdk = 23
        targetSdk = 35
        versionCode = 1
        versionName = "1.0"
    }

    buildTypes {
        getByName("debug") {
            isDebuggable = true
            isMinifyEnabled = false
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}
