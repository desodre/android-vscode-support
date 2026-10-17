package io.github.desodre.jvmcontrol;

public final class JavaHelper {
    private JavaHelper() { }

    public static String message() { return "ready"; }
    public static Class<KotlinEntry> kotlinClass() { return KotlinEntry.class; }
    public static String kotlinMessage() { return KotlinEntry.semanticMarker(); }
}
