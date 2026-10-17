package io.github.desodre.debugfixture

import android.app.Activity
import android.os.Bundle
import android.widget.Button

class MainActivity : Activity() {
    companion object {
        @JvmStatic fun semanticMarker(): Int = 7
    }

    private var taps = 0

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val button = Button(this)
        button.text = "Tap to run Kotlin and Java"
        button.setOnClickListener { runProbe(button) }
        setContentView(button)
    }

    private fun runProbe(button: Button) {
        taps += 1 // Kotlin breakpoint: reachable after each tap.
        val javaValue = JavaProbe.doublePlusOne(taps)
        val kotlinValue = javaValue + 7
        button.text = "Tap $taps: Java=$javaValue Kotlin=$kotlinValue"
    }
}
