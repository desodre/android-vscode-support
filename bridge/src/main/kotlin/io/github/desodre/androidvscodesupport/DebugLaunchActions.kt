package io.github.desodre.androidvscodesupport

import io.github.desodre.adbutils.client.AdbClient
import io.github.desodre.adbutils.model.DeviceSerial
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/** Tracks transient wait-for-debugger settings created by this bridge process. */
internal object DebugLaunchActions {
    private val lock = Mutex()
    private val ownedPackages = mutableMapOf<String, String>()

    suspend fun setWaitForDebugger(client: AdbClient, serial: String?, packageName: String?): JsonElement {
        val selected = DeviceActions.requireSerial(serial)
        val name = DeviceActions.requirePackageName(packageName)
        return lock.withLock {
            val owned = ownedPackages[selected.value]
            require(owned == null || owned == name) {
                "O dispositivo ${selected.value} já aguarda o depurador para $owned."
            }
            if (owned == null) {
                requireNoPersistentDebugApp(client, selected)
                val result = client.device(selected).shellV2("am set-debug-app -w $name")
                require(result.exitCode == 0) {
                    "Falha ao ativar espera pelo depurador para $name: ${(result.stderr + result.stdout).trim()}"
                }
                ownedPackages[selected.value] = name
            }
            buildJsonObject {
                put("packageName", name)
                put("enabled", true)
            }
        }
    }

    suspend fun clearWaitForDebugger(client: AdbClient, serial: String?, packageName: String?): JsonElement {
        val selected = DeviceActions.requireSerial(serial)
        val name = DeviceActions.requirePackageName(packageName)
        return lock.withLock {
            require(ownedPackages[selected.value] == name) {
                "A espera pelo depurador de $name em ${selected.value} não foi criada por este serviço."
            }
            requireNoPersistentDebugApp(client, selected)
            val result = client.device(selected).shellV2("am clear-debug-app")
            require(result.exitCode == 0) {
                "Falha ao limpar espera pelo depurador de $name: ${(result.stderr + result.stdout).trim()}"
            }
            ownedPackages.remove(selected.value)
            buildJsonObject {
                put("packageName", name)
                put("enabled", false)
            }
        }
    }

    private suspend fun requireNoPersistentDebugApp(client: AdbClient, serial: DeviceSerial) {
        val result = client.device(serial).shellV2("settings get global debug_app")
        require(result.exitCode == 0) {
            "Falha ao consultar a configuração de depuração de ${serial.value}: ${(result.stderr + result.stdout).trim()}"
        }
        val configured = result.stdout.trim()
        require(configured.isEmpty() || configured == "null") {
            "O dispositivo ${serial.value} tem uma configuração persistente de depuração para $configured."
        }
    }
}
