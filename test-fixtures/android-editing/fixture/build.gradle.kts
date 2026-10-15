plugins {
    id("com.android.library")
}

android {
    namespace = "io.github.desodre.editinglibrary"
    compileSdk = 35
    defaultConfig { minSdk = 23 }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}
