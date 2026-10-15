package io.github.desodre.androidvscodesupport

import io.github.desodre.adbutils.client.AdbClient
import io.github.desodre.adbutils.transport.AdbTransport
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue

class DebugLaunchActionsTest {
    private class ScriptedTransport(response: ByteArray) : AdbTransport {
        private val bytes = ArrayDeque(response.toList())
        val requests = mutableListOf<String>()
        override suspend fun connect() = Unit
        override suspend fun write(data: ByteArray) { requests += data.decodeToString().drop(4) }
        override suspend fun read(maxBytes: Int): ByteArray = buildList {
            repeat(minOf(maxBytes, bytes.size)) { add(bytes.removeFirst()) }
        }.toByteArray()
        override suspend fun close() = Unit
    }

    private fun listing(serial: String): ScriptedTransport {
        val body = "$serial\tdevice\n"
        return ScriptedTransport(("OKAY" + body.encodeToByteArray().size.toString(16).padStart(4, '0') + body).encodeToByteArray())
    }

    private fun frame(channel: Int, body: String): ByteArray {
        val bytes = body.encodeToByteArray()
        return byteArrayOf(channel.toByte()) + ByteArray(4) { (bytes.size ushr (it * 8)).toByte() } + bytes
    }

    private fun shell(stdout: String = "", stderr: String = "", exitCode: Int = 0): ScriptedTransport =
        ScriptedTransport("OKAYOKAY".encodeToByteArray() + frame(1, stdout) + frame(2, stderr) +
            frame(3, exitCode.toChar().toString()))

    private fun client(vararg transports: ScriptedTransport): AdbClient {
        val queue = ArrayDeque(transports.toList())
        return AdbClient(transportFactory = { queue.removeFirst() })
    }

    @Test fun `wait setting is transient and cleared only for its owner`() = runBlocking {
        val serial = "wait-device-a"
        val packageName = "com.example.wait"
        val settingBefore = shell(stdout = "null\n")
        val set = shell()
        val enabled = DebugLaunchActions.setWaitForDebugger(
            client(listing(serial), settingBefore, listing(serial), set), serial, packageName,
        )
        assertEquals("true", enabled.jsonObject.getValue("enabled").jsonPrimitive.content)
        assertEquals("$packageName", enabled.jsonObject.getValue("packageName").jsonPrimitive.content)
        assertEquals("shell,v2,raw:settings get global debug_app", settingBefore.requests.last())
        assertEquals("shell,v2,raw:am set-debug-app -w $packageName", set.requests.last())

        val neverConnect = AdbClient(transportFactory = { error("Unowned request contacted ADB") })
        assertFailsWith<IllegalArgumentException> {
            DebugLaunchActions.clearWaitForDebugger(neverConnect, "wait-device-b", packageName)
        }
        assertFailsWith<IllegalArgumentException> {
            DebugLaunchActions.clearWaitForDebugger(neverConnect, serial, "com.example.other")
        }
        assertFailsWith<IllegalArgumentException> {
            DebugLaunchActions.setWaitForDebugger(neverConnect, serial, "com.example.other")
        }
        val duplicate = DebugLaunchActions.setWaitForDebugger(neverConnect, serial, packageName)
        assertEquals("true", duplicate.jsonObject.getValue("enabled").jsonPrimitive.content)

        val settingAfter = shell(stdout = "null\n")
        val clear = shell()
        val disabled = DebugLaunchActions.clearWaitForDebugger(
            client(listing(serial), settingAfter, listing(serial), clear), serial, packageName,
        )
        assertEquals("false", disabled.jsonObject.getValue("enabled").jsonPrimitive.content)
        assertEquals("shell,v2,raw:am clear-debug-app", clear.requests.last())
        assertFailsWith<IllegalArgumentException> {
            DebugLaunchActions.clearWaitForDebugger(neverConnect, serial, packageName)
        }
    }

    @Test fun `persistent debug app blocks setting and clearing without touching it`() = runBlocking {
        val serial = "wait-device-c"
        val packageName = "com.example.wait"
        val existing = shell(stdout = "com.example.external\n")
        val error = assertFailsWith<IllegalArgumentException> {
            DebugLaunchActions.setWaitForDebugger(client(listing(serial), existing), serial, packageName)
        }
        assertTrue(error.message.orEmpty().contains("persistente"))
        assertEquals("shell,v2,raw:settings get global debug_app", existing.requests.last())

        DebugLaunchActions.setWaitForDebugger(
            client(listing(serial), shell(stdout = "null\n"), listing(serial), shell()), serial, packageName,
        )
        val changed = shell(stdout = "com.example.external\n")
        assertFailsWith<IllegalArgumentException> {
            DebugLaunchActions.clearWaitForDebugger(client(listing(serial), changed), serial, packageName)
        }
        val clear = shell()
        DebugLaunchActions.clearWaitForDebugger(
            client(listing(serial), shell(stdout = "null\n"), listing(serial), clear), serial, packageName,
        )
        assertEquals("shell,v2,raw:am clear-debug-app", clear.requests.last())
    }

    @Test fun `invalid input and failed shell operations never create or lose ownership`() = runBlocking {
        val serial = "wait-device-d"
        val packageName = "com.example.wait"
        val neverConnect = AdbClient(transportFactory = { error("Invalid request contacted ADB") })
        assertFailsWith<IllegalArgumentException> {
            DebugLaunchActions.setWaitForDebugger(neverConnect, null, packageName)
        }
        assertFailsWith<IllegalArgumentException> {
            DebugLaunchActions.setWaitForDebugger(neverConnect, serial, "com.example;rm")
        }
        assertFailsWith<IllegalArgumentException> {
            DebugLaunchActions.clearWaitForDebugger(neverConnect, serial, packageName)
        }
        val failedSet = shell(stderr = "permission denied", exitCode = 1)
        assertFailsWith<IllegalArgumentException> {
            DebugLaunchActions.setWaitForDebugger(
                client(listing(serial), shell(stdout = "null\n"), listing(serial), failedSet), serial, packageName,
            )
        }
        assertFailsWith<IllegalArgumentException> {
            DebugLaunchActions.clearWaitForDebugger(neverConnect, serial, packageName)
        }

        DebugLaunchActions.setWaitForDebugger(
            client(listing(serial), shell(stdout = "null\n"), listing(serial), shell()), serial, packageName,
        )
        assertFailsWith<IllegalArgumentException> {
            DebugLaunchActions.clearWaitForDebugger(
                client(listing(serial), shell(stdout = "null\n"), listing(serial), shell(stderr = "failed", exitCode = 1)),
                serial, packageName,
            )
        }
        val retry = shell()
        DebugLaunchActions.clearWaitForDebugger(
            client(listing(serial), shell(stdout = "null\n"), listing(serial), retry), serial, packageName,
        )
        assertEquals("shell,v2,raw:am clear-debug-app", retry.requests.last())
    }
}
