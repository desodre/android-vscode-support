package io.github.desodre.androidvscodesupport

import io.github.desodre.adbutils.client.AdbClient
import io.github.desodre.adbutils.transport.AdbTransport
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue

class DebugActionsTest {
    private class ScriptedTransport(response: ByteArray) : AdbTransport {
        private val bytes = ArrayDeque(response.toList())
        val requests = mutableListOf<String>()
        var closed = false
        override suspend fun connect() = Unit
        override suspend fun write(data: ByteArray) { requests += data.decodeToString() }
        override suspend fun read(maxBytes: Int): ByteArray = buildList {
            repeat(minOf(maxBytes, bytes.size)) { add(bytes.removeFirst()) }
        }.toByteArray()
        override suspend fun close() { closed = true }
    }

    private fun listing(serial: String = "device-a") = ScriptedTransport(
        ("OKAY" + "${serial}\tdevice\n".encodeToByteArray().size.toString(16).padStart(4, '0') + "${serial}\tdevice\n")
            .encodeToByteArray()
    )
    private fun forwardListing(remote: String, localPort: Int): ScriptedTransport {
        val body = "device-a tcp:$localPort $remote\n"
        return ScriptedTransport(("OKAY" + body.encodeToByteArray().size.toString(16).padStart(4, '0') + body).encodeToByteArray())
    }
    private fun frame(channel: Int, text: String): ByteArray {
        val bytes = text.encodeToByteArray()
        return byteArrayOf(channel.toByte()) + ByteArray(4) { (bytes.size ushr (it * 8)).toByte() } + bytes
    }
    private fun client(vararg transports: ScriptedTransport): AdbClient {
        val queue = ArrayDeque(transports.toList())
        return AdbClient(transportFactory = { queue.removeFirst() })
    }

    @Test fun `process discovery validates package and filters malformed pidof output`() = runBlocking {
        val device = listing()
        val shell = ScriptedTransport("OKAYOKAY".encodeToByteArray() + frame(1, "413 17 bad 413 -8 0\n") + frame(3, "\u0000"))
        val result = DebugActions.findProcess(client(device, shell), "device-a", "com.example.app")
        assertEquals(listOf("17", "413"), result.jsonObject.getValue("pids").jsonArray.map { it.jsonPrimitive.content })
        assertEquals("host:transport:device-a", shell.requests.first().drop(4))
        assertEquals("shell,v2,raw:pidof 'com.example.app'", shell.requests.last().drop(4))
        assertTrue(device.closed && shell.closed)

        val noProcess = DebugActions.findProcess(client(listing(), ScriptedTransport(
            "OKAYOKAY".encodeToByteArray() + frame(3, "\u0001"))), "device-a", "com.example.app")
        assertTrue(noProcess.jsonObject.getValue("pids").jsonArray.isEmpty())
        val neverConnect = AdbClient(transportFactory = { error("Invalid input contacted ADB") })
        assertFailsWith<IllegalArgumentException> { DebugActions.findProcess(neverConnect, null, "com.example.app") }
        assertFailsWith<IllegalArgumentException> { DebugActions.findProcess(neverConnect, "device-a", "com.example;rm") }
    }

    @Test fun `forward uses selected serial and norebind then removes only owned mapping`() = runBlocking {
        val forward = ScriptedTransport("OKAYOKAY".encodeToByteArray())
        val result = DebugActions.forwardJdwp(client(listing(), forward), "device-a", 413, 48671)
        assertEquals("48671", result.jsonObject.getValue("localPort").jsonPrimitive.content)
        assertEquals("host-serial:device-a:forward:norebind:tcp:48671;jdwp:413", forward.requests.single().drop(4))
        assertTrue(forward.closed)

        val neverConnect = AdbClient(transportFactory = { error("Unowned removal contacted ADB") })
        assertFailsWith<IllegalArgumentException> { DebugActions.removeForward(neverConnect, "device-b", 48671) }
        assertFailsWith<IllegalArgumentException> { DebugActions.removeForward(neverConnect, "device-a", 48672) }
        assertFailsWith<IllegalArgumentException> { DebugActions.forwardJdwp(neverConnect, "device-a", 413, 48671) }

        val remove = ScriptedTransport("OKAYOKAY".encodeToByteArray())
        val mappings = forwardListing("jdwp:413", 48671)
        val removed = DebugActions.removeForward(client(listing(), mappings, remove), "device-a", 48671)
        assertEquals("true", removed.jsonObject.getValue("removed").jsonPrimitive.content)
        assertEquals("host:list-forward", mappings.requests.single().drop(4))
        assertEquals("host-serial:device-a:killforward:tcp:48671", remove.requests.single().drop(4))
        assertFailsWith<IllegalArgumentException> { DebugActions.removeForward(neverConnect, "device-a", 48671) }
    }

    @Test fun `changed mapping is never removed`() = runBlocking {
        DebugActions.forwardJdwp(client(listing(), ScriptedTransport("OKAYOKAY".encodeToByteArray())),
            "device-a", 414, 48674)
        val mapping = forwardListing("jdwp:999", 48674)
        val client = client(listing(), mapping)
        val error = assertFailsWith<IllegalStateException> { DebugActions.removeForward(client, "device-a", 48674) }
        assertTrue(error.message.orEmpty().contains("alterada"))
        assertEquals(1, mapping.requests.size)
        val neverConnect = AdbClient(transportFactory = { error("A changed mapping was removed") })
        assertFailsWith<IllegalArgumentException> { DebugActions.removeForward(neverConnect, "device-a", 48674) }
    }

    @Test fun `invalid targets and failed registration leave no owned mapping`() = runBlocking {
        val neverConnect = AdbClient(transportFactory = { error("Invalid input contacted ADB") })
        assertFailsWith<IllegalArgumentException> { DebugActions.forwardJdwp(neverConnect, null, 3, 48673) }
        assertFailsWith<IllegalArgumentException> { DebugActions.forwardJdwp(neverConnect, "device-a", 0, 48673) }
        assertFailsWith<IllegalArgumentException> { DebugActions.forwardJdwp(neverConnect, "device-a", 3, 0) }
        assertFailsWith<IllegalArgumentException> { DebugActions.removeForward(neverConnect, "device-a", 65536) }
        val failed = ScriptedTransport("OKAYFAIL0004busy".encodeToByteArray())
        assertFailsWith<Exception> { DebugActions.forwardJdwp(client(listing(), failed), "device-a", 3, 48673) }
        assertFailsWith<IllegalArgumentException> { DebugActions.removeForward(neverConnect, "device-a", 48673) }
    }
}
