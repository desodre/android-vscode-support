package io.github.desodre.androidvscodesupport

import io.github.desodre.adbutils.client.AdbClient
import io.github.desodre.adbutils.model.DeviceInfo
import io.github.desodre.adbutils.model.DeviceSerial
import io.github.desodre.adbutils.model.LogcatOptions
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancelChildren
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.joinAll
import kotlinx.coroutines.launch
import kotlinx.coroutines.flow.collect
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonPrimitive
import java.io.File
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicReference

private const val PROTOCOL_VERSION = 1
private val json = Json { ignoreUnknownKeys = true; encodeDefaults = true; explicitNulls = false }

@Serializable
private data class Incoming(
    val version: Int,
    val type: String,
    val id: String? = null,
    val method: String? = null,
    val device: String? = null,
    val params: JsonObject = JsonObject(emptyMap()),
)

@Serializable
private data class WireError(val code: String, val message: String)

@Serializable
private data class Outgoing(
    val version: Int = PROTOCOL_VERSION,
    val type: String,
    val id: String? = null,
    val event: String? = null,
    val result: JsonElement? = null,
    val error: WireError? = null,
)

private fun emit(message: Outgoing) {
    synchronized(System.out) {
        System.out.println(json.encodeToString(message))
        System.out.flush()
    }
}

private fun deviceJson(device: DeviceInfo): JsonObject = buildJsonObject {
    put("serial", device.serial.value)
    put("state", device.state.name.lowercase())
    put("product", device.product?.let(::JsonPrimitive) ?: JsonNull)
    put("model", device.model?.let(::JsonPrimitive) ?: JsonNull)
    put("device", device.device?.let(::JsonPrimitive) ?: JsonNull)
    put("transportId", device.transportId?.let(::JsonPrimitive) ?: JsonNull)
}

private fun devicesJson(devices: List<DeviceInfo>): JsonElement = buildJsonArray {
    devices.forEach { add(deviceJson(it)) }
}

private suspend fun stream(method: String, id: String, serial: String?, params: JsonObject, client: AdbClient) {
    when (method) {
        "devices.track" -> client.trackDevices().collect { devices ->
            emit(Outgoing(type = "event", id = id, event = "devices.changed", result = devicesJson(devices)))
        }
        "logcat.stream" -> {
            val selected = serial?.takeIf { it.isNotBlank() } ?: throw IllegalArgumentException("Serial do dispositivo obrigatório.")
            val processIdText = params["processId"]?.jsonPrimitive?.contentOrNull
            val processId = processIdText?.toIntOrNull()
            require(processIdText == null || processId != null) { "processId inválido." }
            require(processId == null || processId > 0) { "processId deve ser positivo." }
            val packageName = params["packageName"]?.jsonPrimitive?.contentOrNull
            require(packageName == null || packageName.matches(Regex("[A-Za-z][A-Za-z0-9_]*(\\.[A-Za-z][A-Za-z0-9_]*)+"))) {
                "Nome de pacote inválido."
            }
            require(processId == null || packageName == null) { "Informe processId ou packageName, não ambos." }
            val device = client.device(DeviceSerial(selected))
            suspend fun packageProcessIds(): Set<Int> {
                val result = device.shellV2("pidof '$packageName'")
                return if (result.exitCode == 0) result.stdout.trim().split(Regex("\\s+"))
                    .mapNotNull(String::toIntOrNull).toSet() else emptySet()
            }
            val initialIds = when {
                processId != null -> setOf(processId)
                packageName != null -> packageProcessIds()
                else -> emptySet()
            }
            val processIds = AtomicReference(initialIds)
            coroutineScope {
                val poller = if (packageName != null) launch {
                    while (isActive) {
                        delay(1_000)
                        val refreshed = try { packageProcessIds() }
                        catch (error: CancellationException) { throw error }
                        catch (_: Exception) { emptySet() }
                        if (processIds.getAndSet(refreshed) != refreshed) {
                            emit(Outgoing(type = "event", id = id, event = "logcat.filterChanged", result = buildJsonObject {
                                put("processIds", buildJsonArray { refreshed.forEach { add(JsonPrimitive(it)) } })
                            }))
                        }
                    }
                } else null
                try {
                    emit(Outgoing(type = "event", id = id, event = "logcat.started", result = buildJsonObject {
                        put("serial", selected)
                        put("processIds", buildJsonArray { initialIds.forEach { add(JsonPrimitive(it)) } })
                    }))
                    device.logcat(LogcatOptions()).collect { entry ->
                        val accepted = processIds.get()
                        if ((packageName != null || processId != null) && (entry.processId == null || entry.processId !in accepted)) return@collect
                        emit(Outgoing(type = "event", id = id, event = "logcat.entry", result = buildJsonObject {
                            put("rawLine", entry.rawLine)
                            put("message", entry.message)
                            put("timestamp", entry.timestamp?.toString()?.let(::JsonPrimitive) ?: JsonNull)
                            put("processId", entry.processId?.let(::JsonPrimitive) ?: JsonNull)
                            put("threadId", entry.threadId?.let(::JsonPrimitive) ?: JsonNull)
                            put("priority", entry.priority?.name?.lowercase()?.let(::JsonPrimitive) ?: JsonNull)
                            put("tag", entry.tag?.let(::JsonPrimitive) ?: JsonNull)
                        }))
                    }
                } finally {
                    poller?.cancelAndJoin()
                }
            }
        }
        else -> throw IllegalArgumentException("Operação de fluxo desconhecida: $method")
    }
}

private suspend fun handle(method: String, params: JsonObject, serial: String?, client: AdbClient): JsonElement = when (method) {
    "bridge.hello" -> buildJsonObject { put("protocolVersion", PROTOCOL_VERSION) }
    "server.version" -> buildJsonObject { put("version", client.version().value) }
    "devices.list" -> devicesJson(client.devices())
    "app.install" -> DeviceActions.install(client, serial, params["apkPath"]?.jsonPrimitive?.contentOrNull)
    "app.launchers" -> DeviceActions.launchers(client, serial, params["applicationId"]?.jsonPrimitive?.contentOrNull)
    "app.launch" -> DeviceActions.launch(
        client, serial, params["applicationId"]?.jsonPrimitive?.contentOrNull, params["component"]?.jsonPrimitive?.contentOrNull,
    )
    "app.stop" -> DeviceActions.stop(client, serial, params["applicationId"]?.jsonPrimitive?.contentOrNull)
    "debug.findProcess" -> DebugActions.findProcess(client, serial, params["packageName"]?.jsonPrimitive?.contentOrNull)
    "debug.forwardJdwp" -> DebugActions.forwardJdwp(
        client, serial, params["pid"]?.jsonPrimitive?.contentOrNull?.toIntOrNull(),
        params["localPort"]?.jsonPrimitive?.contentOrNull?.toIntOrNull(),
    )
    "debug.removeForward" -> DebugActions.removeForward(
        client, serial, params["localPort"]?.jsonPrimitive?.contentOrNull?.toIntOrNull(),
    )
    "gradle.discoverProjects" -> GradleDiscovery.discover(
        java.io.File(params["projectDir"]?.jsonPrimitive?.contentOrNull ?: throw IllegalArgumentException("projectDir obrigatório.")),
        params["gradleUserHome"]?.jsonPrimitive?.contentOrNull?.let(::File),
    )
    else -> throw IllegalArgumentException("Operação desconhecida: $method")
}

fun main(args: Array<String>) = runBlocking {
    val host = args.getOrNull(0) ?: "127.0.0.1"
    val port = args.getOrNull(1)?.toIntOrNull() ?: 5037
    val client = AdbClient(host, port, timeoutMillis = 120_000)
    val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    val jobs = ConcurrentHashMap<String, kotlinx.coroutines.Job>()

    emit(Outgoing(type = "event", event = "bridge.ready", result = buildJsonObject { put("protocolVersion", PROTOCOL_VERSION) }))
    System.`in`.bufferedReader(Charsets.UTF_8).forEachLine { line ->
        val message = try {
            json.decodeFromString<Incoming>(line)
        } catch (error: Exception) {
            System.err.println("Mensagem inválida: ${error.message}")
            return@forEachLine
        }
        val id = message.id
        if (message.version != PROTOCOL_VERSION) {
            if (id != null) emit(Outgoing(type = "response", id = id, error = WireError("PROTOCOL_VERSION", "Versão do protocolo incompatível.")))
            return@forEachLine
        }
        if (message.type == "cancel") {
            if (id != null) jobs[id]?.cancel()
            return@forEachLine
        }
        if (message.type != "request" || id == null || message.method == null) {
            System.err.println("Mensagem sem tipo, ID ou operação válidos.")
            return@forEachLine
        }
        if (jobs.containsKey(id)) {
            emit(Outgoing(type = "response", id = id, error = WireError("DUPLICATE_ID", "ID de requisição em uso.")))
            return@forEachLine
        }
        val job = scope.launch(start = CoroutineStart.LAZY) {
            try {
                if (message.method == "devices.track" || message.method == "logcat.stream") {
                    stream(message.method, id, message.device, message.params, client)
                    emit(Outgoing(type = "response", id = id, result = JsonNull))
                } else {
                    emit(Outgoing(type = "response", id = id, result = handle(message.method, message.params, message.device, client)))
                }
            } catch (_: CancellationException) {
                emit(Outgoing(type = "response", id = id, error = WireError("CANCELLED", "Operação cancelada.")))
            } catch (error: Exception) {
                System.err.println("${message.method}: ${error.message}")
                emit(Outgoing(type = "response", id = id, error = WireError(error.javaClass.simpleName, error.message ?: "Falha no ADB.")))
            } finally {
                jobs.remove(id)
            }
        }
        val previous = jobs.putIfAbsent(id, job)
        if (previous == null) job.start() else {
            job.cancel()
            emit(Outgoing(type = "response", id = id, error = WireError("DUPLICATE_ID", "ID de requisição em uso.")))
        }
    }
    scope.coroutineContext.cancelChildren()
    jobs.values.toList().joinAll()
}
