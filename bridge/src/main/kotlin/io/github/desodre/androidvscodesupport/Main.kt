package io.github.desodre.androidvscodesupport

import io.github.desodre.adbutils.client.AdbClient
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancelChildren
import kotlinx.coroutines.joinAll
import kotlinx.coroutines.launch
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

private suspend fun handle(method: String, params: JsonObject, client: AdbClient): JsonElement = when (method) {
    "bridge.hello" -> buildJsonObject { put("protocolVersion", PROTOCOL_VERSION) }
    "server.version" -> buildJsonObject { put("version", client.version().value) }
    "devices.list" -> buildJsonArray {
        client.devices().forEach { device ->
            add(buildJsonObject {
                put("serial", device.serial.value)
                put("state", device.state.name.lowercase())
                put("product", device.product?.let(::JsonPrimitive) ?: JsonNull)
                put("model", device.model?.let(::JsonPrimitive) ?: JsonNull)
                put("device", device.device?.let(::JsonPrimitive) ?: JsonNull)
                put("transportId", device.transportId?.let(::JsonPrimitive) ?: JsonNull)
            })
        }
    }
    "gradle.discoverProjects" -> GradleDiscovery.discover(
        java.io.File(params["projectDir"]?.jsonPrimitive?.contentOrNull ?: throw IllegalArgumentException("projectDir obrigatório.")),
        params["gradleUserHome"]?.jsonPrimitive?.contentOrNull?.let(::File),
    )
    else -> throw IllegalArgumentException("Operação desconhecida: $method")
}

fun main(args: Array<String>) = runBlocking {
    val host = args.getOrNull(0) ?: "127.0.0.1"
    val port = args.getOrNull(1)?.toIntOrNull() ?: 5037
    val client = AdbClient(host, port)
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
                emit(Outgoing(type = "response", id = id, result = handle(message.method, message.params, client)))
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
