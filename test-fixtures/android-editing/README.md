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

## Kotlin/Java import probe (#23)

`language-import-smoke.js` uses the real `JetBrains.kotlin-server` and `redhat.java` extensions. It records versions, Java project/source paths, Kotlin→Java and Java→Kotlin definitions, completion, and diagnostics after import. Run it with an isolated VS Code profile and both language extensions in its extensions directory. Set `java.jdt.ls.androidSupport.enabled` to `on` and `java.import.gradle.java.home` to a JDK 21 path in that profile's `User/settings.json`. The Kotlin server needs a suitable JDK on the host as described in `docs/language-support.md`. The probe only reads project files and writes a JSON report; its results are evidence, not a passing assertion for #23. Check that the JSON file was created, because the VS Code CLI can exit successfully even if an extension test fails.

```sh
ANDROID_LANGUAGE_RESULT=/tmp/android-language-result.json code --wait \
  --extensionDevelopmentPath="$PWD" \
  --extensionTestsPath="$PWD/test-fixtures/android-editing/language-import-smoke.js" \
  --user-data-dir=/tmp/android-language-profile \
  --extensions-dir=/tmp/android-language-extensions \
  "$PWD/test-fixtures/android-editing"
```

Run from the repository root after compiling the extension and building the fixture. An empty Java source-path list or missing cross-language definition means the issue remains open, even if both Gradle variants build.
