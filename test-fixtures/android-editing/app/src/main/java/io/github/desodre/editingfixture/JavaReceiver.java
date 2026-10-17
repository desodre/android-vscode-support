package io.github.desodre.editingfixture;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

public final class JavaReceiver extends BroadcastReceiver {
    public static int labelResource() { return R.string.app_label; }
    public static Class<MainActivity> activityClass() { return MainActivity.class; }
    public static int kotlinMarker() { return MainActivity.semanticMarker(); }

    @Override public void onReceive(Context context, Intent intent) { }
}
