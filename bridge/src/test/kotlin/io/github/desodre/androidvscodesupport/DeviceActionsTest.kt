package io.github.desodre.androidvscodesupport

import io.github.desodre.adbutils.client.AdbClient
import io.github.desodre.adbutils.transport.AdbTransport
import kotlinx.coroutines.runBlocking
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith

class DeviceActionsTest {
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

    @Test
    fun launchesWaitingAppWithoutBlockingForActivityCompletion() = runBlocking {
        val body = "device-a\tdevice\n"
        val listing = ScriptedTransport(("OKAY" + body.encodeToByteArray().size.toString(16).padStart(4, '0') + body).encodeToByteArray())
        val shell = ScriptedTransport("OKAYOKAY".encodeToByteArray() + byteArrayOf(3, 1, 0, 0, 0, 0))
        val transports = ArrayDeque(listOf(listing, shell))
        DeviceActions.launch(AdbClient(transportFactory = { transports.removeFirst() }),
            "device-a", "com.example.app", "com.example.app/.MainActivity", waitForDebugger = true)
        assertEquals("shell,v2,raw:am start -a android.intent.action.MAIN -c android.intent.category.LAUNCHER -n com.example.app/.MainActivity",
            shell.requests.last())
    }

    @Test
    fun rejectsMissingSerialAndUnsafePackage() {
        assertFailsWith<IllegalArgumentException> { DeviceActions.requireSerial(null) }
        assertFailsWith<IllegalArgumentException> { DeviceActions.requirePackageName("com.example;rm") }
        assertFailsWith<IllegalArgumentException> { DeviceActions.requirePackageName("example") }
        assertEquals("com.example.app", DeviceActions.requirePackageName("com.example.app"))
    }

    @Test
    fun keepsOnlyLauncherActivitiesFromSelectedPackage() {
        val output = """
            com.example.app/.MainActivity
            com.other.app/.OtherActivity
            com.example.app/com.example.app.SecondActivity
            No activities found
            com.example.app/.MainActivity
            com.example.app/.Bad;rm
        """.trimIndent()
        assertEquals(
            listOf("com.example.app/.MainActivity", "com.example.app/com.example.app.SecondActivity"),
            DeviceActions.parseLauncherActivities(output, "com.example.app"),
        )
    }
}
