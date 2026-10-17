package io.github.desodre.debugfixture;

import android.app.Activity;

public final class JavaProbe {
    private JavaProbe() {}

    public static int doublePlusOne(int input) {
        int doubled = input * 2; // Java breakpoint: reachable after each tap.
        return doubled + 1;
    }

    public static Class<? extends Activity> activityClass() { return MainActivity.class; }
    public static int kotlinMarker() { return MainActivity.semanticMarker(); }
}
