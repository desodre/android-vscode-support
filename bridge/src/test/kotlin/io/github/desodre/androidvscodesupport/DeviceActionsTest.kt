package io.github.desodre.androidvscodesupport

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith

class DeviceActionsTest {
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
