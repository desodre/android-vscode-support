package io.github.desodre.androidvscodesupport

import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import java.io.File
import java.nio.file.Files
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue

/**
 * Usa builds Gradle reais pelo Tooling API. O AGP é simulado por um plugin em buildSrc que expõe o
 * mesmo contrato público (`androidComponents.finalizeDsl/onVariants`), o que mantém o teste offline
 * e sem Android SDK. O formato de build.gradle nunca é interpretado pelo código sob teste.
 */
class GradleDiscoveryTest {
    private fun fixture(): File {
        val dir = Files.createTempDirectory("agy-discovery").toFile()
        dir.deleteOnExit()
        File(dir, "gradle/wrapper").mkdirs()
        File(dir, "gradle/wrapper/gradle-wrapper.properties").writeText(
            File("../gradle/wrapper/gradle-wrapper.properties").readText()
        )
        return dir
    }

    private fun write(dir: File, path: String, text: String) {
        File(dir, path).also { it.parentFile.mkdirs() }.writeText(text.trimIndent())
    }

    private fun fakeAgp(dir: File) {
        write(dir, "buildSrc/build.gradle", "plugins { id 'java' }\ndependencies { compileOnly gradleApi() }")
        for ((id, cls) in mapOf("com.android.application" to "FakeApp", "com.android.library" to "FakeLib")) {
            write(dir, "buildSrc/src/main/resources/META-INF/gradle-plugins/$id.properties", "implementation-class=fake.$cls")
        }
        write(dir, "buildSrc/src/main/java/fake/FakeAgp.java", """
            package fake;
            import java.util.*;
            import org.gradle.api.*;
            public abstract class FakeAgp implements Plugin<Project> {
                public static class Pair { public final String first, second; Pair(String a, String b) { first = a; second = b; } public String getFirst() { return first; } public String getSecond() { return second; } }
                public static class Dsl { public String getNamespace() { return "com.example.fake"; } }
                public static class Variant {
                    final String name, buildType; final List<Pair> flavors; final boolean app;
                    Variant(String n, String b, List<Pair> f, boolean app) { name = n; buildType = b; flavors = f; this.app = app; }
                    public String getName() { return name; }
                    public String getBuildType() { return buildType; }
                    public List<Pair> getProductFlavors() { return flavors; }
                    public org.gradle.api.provider.Provider<String> getApplicationId(Project p) { return null; }
                }
                public static class Selector { public Selector all() { return this; } }
                public static class Components {
                    final List<Variant> variants; Action<Dsl> dsl;
                    Components(List<Variant> v) { variants = v; }
                    public Selector selector() { return new Selector(); }
                    public void finalizeDsl(Action<Dsl> a) { dsl = a; }
                    public void onVariants(Selector s, Action<Variant> a) {
                        if (dsl != null) dsl.execute(new Dsl());
                        variants.forEach(a::execute);
                    }
                }
                protected abstract boolean app();
                public void apply(Project p) {
                    for (String configuration : new String[] {"implementation", "api", "freeImplementation", "paidImplementation"}) {
                        p.getConfigurations().maybeCreate(configuration);
                    }
                    List<Variant> vs = new ArrayList<>();
                    for (String bt : new String[] {"debug", "release"}) {
                        if (app()) {
                            vs.add(new Variant("free" + (bt.equals("debug") ? "Debug" : "Release"), bt, List.of(new Pair("tier", "free")), true));
                            vs.add(new Variant("paid" + (bt.equals("debug") ? "Debug" : "Release"), bt, List.of(new Pair("tier", "paid")), true));
                        } else vs.add(new Variant(bt, bt, List.of(), false));
                    }
                    p.getExtensions().add("androidComponents", new Components(vs));
                }
            }
        """)
        write(dir, "buildSrc/src/main/java/fake/FakeApp.java", "package fake; public class FakeApp extends FakeAgp { protected boolean app() { return true; } }")
        write(dir, "buildSrc/src/main/java/fake/FakeLib.java", "package fake; public class FakeLib extends FakeAgp { protected boolean app() { return false; } }")
    }

    private fun projects(result: JsonObject) = result["projects"]!!.jsonArray.map { it.jsonObject }.associateBy { it["path"]!!.jsonPrimitive.content }

    @Test
    fun `descobre modulos android, flavors e variantes por APIs publicas`() {
        val dir = fixture()
        fakeAgp(dir)
        write(dir, "settings.gradle", "rootProject.name = 'sample'\ninclude ':app', ':lib', ':plain'")
        write(dir, "app/build.gradle", "plugins { id 'com.android.application' }\ndependencies { implementation project(':lib') }")
        write(dir, "lib/build.gradle", "plugins { id 'com.android.library' }")
        write(dir, "plain/build.gradle", "")

        val result = runBlocking { GradleDiscovery.discover(dir) }.jsonObject
        val byPath = projects(result)
        assertEquals(setOf(":", ":app", ":lib", ":plain"), byPath.keys)
        assertEquals(JsonNull, byPath[":plain"]!!["android"] ?: JsonNull)
        assertEquals(JsonNull, byPath[":"]!!["android"] ?: JsonNull)

        val app = byPath[":app"]!!["android"]!!.jsonObject
        assertEquals("application", app["type"]!!.jsonPrimitive.content)
        assertEquals("com.example.fake", app["namespace"]!!.jsonPrimitive.content)
        val variants = app["variants"]!!.jsonArray.map { it.jsonObject }
        assertEquals(listOf("freeDebug", "paidDebug", "freeRelease", "paidRelease").sorted(), variants.map { it["name"]!!.jsonPrimitive.content }.sorted())
        val free = variants.first { it["name"]!!.jsonPrimitive.content == "freeDebug" }
        assertEquals("debug", free["buildType"]!!.jsonPrimitive.content)
        val flavor = free["flavors"]!!.jsonArray.single().jsonObject
        assertEquals("tier", flavor["dimension"]!!.jsonPrimitive.content)
        assertEquals("free", flavor["name"]!!.jsonPrimitive.content)
        assertEquals(listOf(":lib"), free["projectDependencies"]!!.jsonArray.map { it.jsonPrimitive.content })

        val lib = byPath[":lib"]!!["android"]!!.jsonObject
        assertEquals("library", lib["type"]!!.jsonPrimitive.content)
        assertEquals(listOf("debug", "release"), lib["variants"]!!.jsonArray.map { it.jsonObject["name"]!!.jsonPrimitive.content }.sorted())
        assertTrue(lib["variants"]!!.jsonArray.all { it.jsonObject["flavors"] is JsonArray })
    }

    @Test
    fun `build sem android retorna projetos sem modulos android`() {
        val dir = fixture()
        write(dir, "settings.gradle", "rootProject.name = 'plain'\ninclude ':a'")
        write(dir, "a/build.gradle", "")
        val result = runBlocking { GradleDiscovery.discover(dir) }.jsonObject
        assertTrue(projects(result).values.all { (it["android"] ?: JsonNull) == JsonNull })
        assertEquals(dir.canonicalPath, File(result["rootDir"]!!.jsonPrimitive.content).canonicalPath)
    }

    @Test
    fun `diretorio inexistente falha com erro claro`() {
        assertFailsWith<IllegalArgumentException> { runBlocking { GradleDiscovery.discover(File("/nonexistent/agy")) } }
    }
}
