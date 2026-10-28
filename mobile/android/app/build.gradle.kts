plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.codassol.mobile"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.codassol.mobile"
        minSdk = 30
        targetSdk = 35
        testInstrumentationRunner = "com.codassol.mobile.PhoneInstrumentation"
        versionCode = 4
        versionName = "0.1.0-wireless-preview.3"
    }

    buildTypes {
        release {
            isMinifyEnabled = false
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }
}
