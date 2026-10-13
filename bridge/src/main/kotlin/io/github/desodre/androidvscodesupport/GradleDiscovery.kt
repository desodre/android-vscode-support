package io.github.desodre.androidvscodesupport

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import org.gradle.tooling.GradleConnector
import java.io.ByteArrayOutputStream
import java.io.File
import java.nio.file.Files
import java.util.concurrent.atomic.AtomicBoolean

/** Modelo customizado servido pelo init script (o Tooling API adapta o getter [getJson]). */
interface AndroidDiscoveryModel {
    fun getJson(): String
}

object GradleDiscovery {
    private val json = Json { ignoreUnknownKeys = true }

    /**
     * Conecta ao build Gradle em [projectDir] pelo Tooling API e devolve projetos/módulos Android,
     * flavors e variantes reportados pelo AGP via `AndroidComponentsExtension` (API pública).
     */
    suspend fun discover(projectDir: File, gradleUserHome: File? = null): JsonElement {
        require(projectDir.isDirectory) { "Diretório inexistente: $projectDir" }
        val initScript = Files.createTempFile("android-discovery", ".init.gradle").toFile()
        try {
            val resource = GradleDiscovery::class.java.getResourceAsStream("/android-discovery.init.gradle")
                ?: error("Init script de descoberta ausente.")
            resource.use { initScript.outputStream().use(it::copyTo) }
            val cancellation = GradleConnector.newCancellationTokenSource()
            val finished = AtomicBoolean(false)
            return coroutineScope {
                val watcher = launch {
                    try { awaitCancellation() } finally { if (!finished.get()) cancellation.cancel() }
                }
                try {
                    withContext(Dispatchers.IO) { query(projectDir, gradleUserHome, initScript, cancellation) }
                } finally {
                    finished.set(true)
                    watcher.cancel()
                }
            }
        } finally {
            initScript.delete()
        }
    }

    private fun query(
        projectDir: File, gradleUserHome: File?, initScript: File,
        cancellation: org.gradle.tooling.CancellationTokenSource,
    ): JsonElement {
        val connector = GradleConnector.newConnector().forProjectDirectory(projectDir)
        if (gradleUserHome != null) connector.useGradleUserHomeDir(gradleUserHome)
        val connection = connector.connect()
        try {
            val stderr = ByteArrayOutputStream()
            val raw = connection.model(AndroidDiscoveryModel::class.java)
                .withCancellationToken(cancellation.token())
                .addArguments("--init-script", initScript.absolutePath, "--quiet")
                .setStandardOutput(stderr)
                .setStandardError(stderr)
                .get()
                .getJson()
            return json.parseToJsonElement(raw)
        } finally {
            connection.close()
        }
    }
}
