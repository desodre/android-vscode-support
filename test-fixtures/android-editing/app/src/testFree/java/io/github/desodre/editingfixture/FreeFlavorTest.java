package io.github.desodre.editingfixture;

import static org.junit.Assert.assertEquals;

import org.junit.Test;

public class FreeFlavorTest {
    @Test
    public void flavorIsFree() {
        assertEquals("free", BuildConfig.FLAVOR);
    }
}
