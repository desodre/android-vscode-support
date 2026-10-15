package io.github.desodre.debugfixture

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log

/** Emits an opt-in marker from the app process for physical Logcat smoke tests. */
class Stage3ProbeReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        Log.i("AndroidVSCodeStage3", intent.getStringExtra("marker") ?: "stage3-probe")
    }
}
