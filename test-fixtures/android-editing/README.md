# Android editing fixture

This small Gradle project has a Kotlin app, a Java library, and `free`/`paid` flavors. It proves the Android extension's own XML and resource navigation without depending on the Kotlin or Java language servers (their import behavior belongs to issue #23). Both variants compile with AGP 9.0.1 and JDK 21.

The opt-in `xml-navigation-smoke.js` runs in a VS Code Extension Development Host and verifies:

- Manifest components navigate to Kotlin and Java classes; its label navigates to `strings.xml`.
- Kotlin and Java `R.string` uses navigate to values XML, including a resource in the local library module.
- A layout reference navigates to the `free` resource, then to the `paid` resource after selecting that variant.
- An unsaved missing XML resource produces a warning over the original reference; restoring the text clears it.

From the repository root, with the Android SDK and JDK 21 configured:

```sh
npm run compile
./gradlew :bridge:installDist -q
./gradlew -p test-fixtures/android-editing :app:assembleFreeDebug :app:assemblePaidDebug -q
mkdir -p /tmp/android-editing-smoke/User /tmp/android-editing-smoke/extensions
ln -s "$PWD/test-fixtures/android-editing/kotlin-language" /tmp/android-editing-smoke/extensions/android-fixture-kotlin-language
printf '%s\n' '{"security.workspace.trust.enabled":false}' > /tmp/android-editing-smoke/User/settings.json
rm -f /tmp/android-editing-result
ANDROID_XML_RESULT=/tmp/android-editing-result code --wait \
  --extensionDevelopmentPath="$PWD" \
  --extensionTestsPath="$PWD/test-fixtures/android-editing/xml-navigation-smoke.js" \
  --user-data-dir=/tmp/android-editing-smoke \
  --extensions-dir=/tmp/android-editing-smoke/extensions \
  "$PWD/test-fixtures/android-editing"
grep -qx PASS /tmp/android-editing-result
```

Set `JAVA_HOME` and `ANDROID_HOME` in the shell if they are not already set. The small `kotlin-language` fixture only registers the `.kt` language ID, so this test isolates the extension's resource provider. The VS Code CLI may exit with code 0 even when a test assertion fails; check the result file. The test restores unsaved XML changes and its temporary diagnostics setting before exiting.
