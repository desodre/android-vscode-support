package io.github.desodre.jvmcontrol

class KotlinEntry {
    fun message(): String = JavaHelper.message()

    companion object {
        @JvmStatic fun semanticMarker(): String = "kotlin"
    }
}
