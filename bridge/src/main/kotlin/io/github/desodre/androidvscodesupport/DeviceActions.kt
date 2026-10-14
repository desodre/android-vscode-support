package io.github.desodre.androidvscodesupport

import io.github.desodre.adbutils.client.AdbClient
import io.github.desodre.adbutils.model.DeviceSerial
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.nio.file.Files
import java.nio.file.Path

internal object DeviceActions {
    private val packageNamePattern = Regex("[A-Za-z][A-Za-z0-9_]*(\\.[A-Za-z][A-Za-z0-9_]*)+")
    private val activityNamePattern = Regex("[A-Za-z_.$][A-Za-z0-9_.$]*")
    private const val MAX_APK_BYTES = 512L * 1024 * 1024

    fun requirePackageName(value: String?): String {
        val name = value ?: throw IllegalArgumentException("applicationId obrigatório.")
        require(packageNamePattern.matches(name)) { "applicationId inválido: $name" }
        return name
    }

    fun requireSerial(value: String?): DeviceSerial =
        DeviceSerial(value ?: throw IllegalArgumentException("Selecione um dispositivo antes de executar esta operação."))

    fun parseLauncherActivities(output: String, packageName: String): List<String> {
        requirePackageName(packageName)
        return output.lineSequence().map(String::trim).filter { it.startsWith("$packageName/") }
            .filter { activityNamePattern.matches(it.substringAfter('/')) }
            .distinct().toList()
    }

    suspend fun install(client: AdbClient, serial: String?, apkPath: String?): JsonElement {
        val selected = requireSerial(serial)
        val device = client.device(selected)
        val path = apkPath?.let(Path::of) ?: throw IllegalArgumentException("Caminho do APK obrigatório.")
        require(path.isAbsolute && path.fileName.toString().endsWith(".apk", ignoreCase = true)) { "Selecione um arquivo APK absoluto." }
        val size = withContext(Dispatchers.IO) {
            require(Files.isRegularFile(path)) { "APK não encontrado: $path" }
            Files.size(path)
        }
        require(size in 1..MAX_APK_BYTES) { "APK vazio ou maior que 512 MiB; use a instalação pelo SDK para este arquivo." }
        val apk = withContext(Dispatchers.IO) { Files.readAllBytes(path) }
        val result = device.install(apk)
        return buildJsonObject { put("message", result.message) }
    }

    suspend fun launchers(client: AdbClient, serial: String?, packageName: String?): JsonElement {
        val name = requirePackageName(packageName)
        val result = client.device(requireSerial(serial)).shellV2(
            "cmd package query-activities --components -a android.intent.action.MAIN -c android.intent.category.LAUNCHER $name"
        )
        require(result.exitCode == 0) {
            "Falha ao consultar atividades de $name: ${(result.stderr + result.stdout).trim()}"
        }
        return buildJsonArray { parseLauncherActivities(result.stdout, name).forEach { add(JsonPrimitive(it)) } }
    }

    suspend fun launch(client: AdbClient, serial: String?, packageName: String?, component: String?): JsonElement {
        val name = requirePackageName(packageName)
        val target = component ?: throw IllegalArgumentException("Atividade inicial obrigatória.")
        require(target.startsWith("$name/") && activityNamePattern.matches(target.substringAfter('/'))) {
            "Atividade inicial inválida para $name."
        }
        val result = client.device(requireSerial(serial)).shellV2(
            "am start -W -a android.intent.action.MAIN -c android.intent.category.LAUNCHER -n $target"
        )
        val output = (result.stdout + result.stderr).trim()
        require(result.exitCode == 0 && !output.lineSequence().any { it.trimStart().startsWith("Error:") }) {
            "Falha ao iniciar $name: ${output.ifEmpty { "sem detalhes do Android" }}"
        }
        return buildJsonObject { put("message", output) }
    }

    suspend fun stop(client: AdbClient, serial: String?, packageName: String?): JsonElement {
        val name = requirePackageName(packageName)
        val result = client.device(requireSerial(serial)).shellV2("am force-stop $name")
        require(result.exitCode == 0) {
            "Falha ao parar $name: ${(result.stderr + result.stdout).trim()}"
        }
        return buildJsonObject { put("message", "Aplicativo $name parado.") }
    }
}
