package io.github.desodre.debugfixture;

public final class JavaProbe {
    private JavaProbe() {}

    public static int doublePlusOne(int input) {
        int doubled = input * 2; // Java breakpoint: reachable after each tap.
        return doubled + 1;
    }
}
