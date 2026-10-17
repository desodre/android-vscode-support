# JVM language-server control

Minimal Kotlin/Java Gradle project without Android Gradle Plugin. The language matrix compares it with the single-module and multi-module Android fixtures to distinguish a general language-server failure from Android import failures.

With JDK 21 configured, run `./gradlew -p test-fixtures/jvm-editing build -q` from the repository root. Run `language-matrix-smoke.js` with `ANDROID_LANGUAGE_SCENARIO=jvm` and this directory opened as the VS Code workspace.
