package io.github.desodre.androidvscodesupport

import io.github.desodre.adbutils.client.AdbClient
import io.github.desodre.adbutils.model.JdwpPid
import io.github.desodre.adbutils.model.TcpPort
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.util.concurrent.ConcurrentHashMap

/** Only forwards registered through this bridge can be removed through its debug API. */
internal object DebugActions {
    private data class ForwardKey(val serial: String, val localPort: Int)
    private class MappingChangedException(message: String) : IllegalStateException(message)
    private val ownedForwards = ConcurrentHashMap<ForwardKey, Int>()

    fun parseProcessIds(output: String): List<Int> = output.split(Regex("\\s+"))
        .mapNotNull { it.toIntOrNull()?.takeIf { pid -> pid > 0 } }
        .distinct().sorted()

    suspend fun findProcess(client: AdbClient, serial: String?, packageName: String?): JsonElement {
        val selected = DeviceActions.requireSerial(serial)
        val name = DeviceActions.requirePackageName(packageName)
        val result = client.device(selected).shellV2("pidof '$name'")
        require(result.exitCode == 0 || (result.exitCode == 1 && result.stdout.isBlank())) {
            "Falha ao localizar o processo de $name: ${(result.stderr + result.stdout).trim()}"
        }
        return buildJsonObject {
            put("pids", buildJsonArray { parseProcessIds(result.stdout).forEach { add(JsonPrimitive(it)) } })
        }
    }

    suspend fun forwardJdwp(client: AdbClient, serial: String?, pid: Int?, localPort: Int?): JsonElement {
        val selected = DeviceActions.requireSerial(serial)
        val target = JdwpPid(pid ?: throw IllegalArgumentException("pid obrigatório."))
        val local = TcpPort(localPort ?: throw IllegalArgumentException("localPort obrigatório."))
        val key = ForwardKey(selected.value, local.value)
        require(ownedForwards.putIfAbsent(key, target.value) == null) {
            "A porta ${local.value} já pertence a uma sessão de depuração deste serviço."
        }
        try {
            client.device(selected).forward(local, target, noRebind = true)
        } catch (error: Throwable) {
            ownedForwards.remove(key, target.value)
            throw error
        }
        return buildJsonObject { put("localPort", local.value) }
    }

    suspend fun removeForward(client: AdbClient, serial: String?, localPort: Int?): JsonElement {
        val selected = DeviceActions.requireSerial(serial)
        val local = TcpPort(localPort ?: throw IllegalArgumentException("localPort obrigatório."))
        val key = ForwardKey(selected.value, local.value)
        val pid = ownedForwards.remove(key)
            ?: throw IllegalArgumentException("O forward TCP ${local.value} não foi criado por este serviço para ${selected.value}.")
        try {
            val device = client.device(selected)
            val current = device.listForwardMappings().firstOrNull { it.local == local }
            if (current != null) {
                if (current.remote != JdwpPid(pid)) {
                    throw MappingChangedException(
                        "A porta ${local.value} foi alterada por outro processo; o forward atual não será removido."
                    )
                }
                device.removeForward(local)
            }
        } catch (error: Throwable) {
            if (error !is MappingChangedException) {
                ownedForwards.putIfAbsent(key, pid)
            }
            throw error
        }
        return buildJsonObject { put("removed", true) }
    }
}
