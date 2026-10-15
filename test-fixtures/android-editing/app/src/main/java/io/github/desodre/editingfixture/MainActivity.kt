package io.github.desodre.editingfixture

import android.app.Activity
import android.os.Bundle
import android.widget.TextView
import io.github.desodre.editinglibrary.SharedNames

class MainActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val title = TextView(this)
        title.text = getString(R.string.app_label) + getString(R.string.flavor_label) +
            getString(SharedNames.labelResource()) +
            getString(io.github.desodre.editinglibrary.R.string.shared_label)
        title.id = R.id.title
        setContentView(title)
    }
}
