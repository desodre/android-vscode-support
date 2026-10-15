# Android debug fixture

Small debuggable Android app with one Kotlin and one Java breakpoint. Tapping the full-screen button calls `MainActivity.runProbe` and then `JavaProbe.doublePlusOne`.

## Build and run

From the repository root, with JDK 21 and Android SDK configured:

```sh
./gradlew -p test-fixtures/android-debug :app:assembleDebug -q
adb -s SERIAL install -r test-fixtures/android-debug/app/build/outputs/apk/debug/app-debug.apk
adb -s SERIAL shell am start -n io.github.desodre.debugfixture/.MainActivity
```

For Kotlin by JetBrains, the bundled runtime may lack `jlink`, which Android Gradle Plugin needs while importing the project. If the import reports a missing `jlink`, create a **local**, ignored `test-fixtures/android-debug/gradle.properties` with `org.gradle.java.home` pointing to an installed full JDK 21. The `intellij.jdkForSymbolResolution` setting alone does not choose Gradle's JVM.

Open `test-fixtures/android-debug` as a VS Code workspace. Set breakpoints at `MainActivity.kt:19` and `JavaProbe.java:7`, attach through **Android: Conectar depurador ao aplicativo em execução**, then tap the button. Check the call stack, the `input` argument in Java, stepping, and expression evaluation. End the debug session and verify `adb -s SERIAL forward --list` no longer contains its local JDWP port.

The fixture has its own Gradle settings so it does not affect the extension build. Its debug APK and `local.properties` are generated locally and must not be committed.

## Physical device and Logcat smoke test

The opt-in `physical-device-smoke.js` uses the production Kotlin bridge and TypeScript app helpers. It checks explicit device selection and a live `track-devices` snapshot, installs this APK, discovers and launches its Activity, stops and restarts the app, receives Logcat markers filtered by package and PID, and cancels both streams. The fixture's exported `Stage3ProbeReceiver` emits a marker only when the test sends it an explicit broadcast. The test stops the app in its cleanup block.

Build the extension, bridge, and APK, start the ADB server, and set `ANDROID_SERIAL` to an authorized physical device:

```sh
npm run compile
./gradlew :bridge:installDist -q
./gradlew -p test-fixtures/android-debug :app:assembleDebug -q
ANDROID_SERIAL=SERIAL node test-fixtures/android-debug/physical-device-smoke.js
```

The smoke test uses one real device. Unit tests in `src/test/deviceSelection.test.ts` cover selection with two online devices, state changes, and `offline`/`unauthorized` states. AVD startup and the VS Code **Executar** command remain separate validations.

## Repeatable Java DAP smoke test

The opt-in `physical-dap-smoke.js` test installs and starts this fixture on `ANDROID_SERIAL`, verifies a Java breakpoint, stack, variable, expression and step in VS Code, then removes its JDWP forward and stops the app. Build the extension (`npm run compile`), Kotlin bridge (`./gradlew :bridge:installDist`) and APK first. Install **Debugger for Java** in the VS Code extensions directory used for the run.

```sh
mkdir -p /tmp/android-debug-smoke/User
printf '%s\n' '{"security.workspace.trust.enabled":false}' > /tmp/android-debug-smoke/User/settings.json
ANDROID_SERIAL=SERIAL code --wait \
  --extensionDevelopmentPath="$PWD" \
  --extensionTestsPath="$PWD/test-fixtures/android-debug/physical-dap-smoke.js" \
  --user-data-dir=/tmp/android-debug-smoke \
  --extensions-dir="$HOME/.vscode/extensions" \
  "$PWD/test-fixtures/android-debug"
```

Run this from the repository root. The fixture is the workspace opened by the test host. Use a new or reusable isolated `/tmp/android-debug-smoke` profile as shown, and keep the Android device unlocked during the run.
