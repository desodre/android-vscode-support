package io.github.desodre.editingfixture

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class BuildFlavorTest {
    @Test
    fun applicationIdIsStable() {
        assertEquals("io.github.desodre.editingfixture", BuildConfig.APPLICATION_ID)
    }

    @Test
    fun `flavor is one of the declared tiers`() {
        assertTrue(BuildConfig.FLAVOR in setOf("free", "paid"))
    }
}
