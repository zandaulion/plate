package app.plate

import android.content.Intent
import android.graphics.Color
import android.graphics.drawable.GradientDrawable
import android.os.Bundle
import android.view.Gravity
import android.view.View
import android.widget.Button
import android.widget.FrameLayout
import android.widget.LinearLayout
import androidx.activity.ComponentActivity
import androidx.activity.result.contract.ActivityResultContracts

/**
 * Hosts the locally packaged Plate interface. The WebView is a presentation
 * layer only: native code will own persistence, camera/barcode access and the
 * narrowly-scoped network calls rather than relying on a web server.
 */
class MainActivity : ComponentActivity() {
    private lateinit var plateWebView: PlateWebView
    private lateinit var manualAction: Button
    private lateinit var barcodeAction: Button
    private lateinit var photoAction: Button

    private val barcodeScanner = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult(),
    ) { result ->
        val barcode = result.data?.getStringExtra(BarcodeScanActivity.EXTRA_BARCODE)
        // An empty value includes cancellation and permission denial. The web
        // interface treats it as a dismissed scan instead of showing an error.
        plateWebView.deliverBarcode(barcode.orEmpty())
    }

    private val backupExporter = registerForActivityResult(
        ActivityResultContracts.CreateDocument("application/zip"),
    ) { uri ->
        if (uri == null) plateWebView.deliverBackupCancelled("export")
        else plateWebView.exportBackup(uri)
    }

    private val backupImporter = registerForActivityResult(
        ActivityResultContracts.OpenDocument(),
    ) { uri ->
        if (uri == null) plateWebView.deliverBackupCancelled("import")
        else plateWebView.importBackup(uri)
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        plateWebView = PlateWebView(
            context = this,
            onBarcodeScanRequested = {
                barcodeScanner.launch(Intent(this, BarcodeScanActivity::class.java))
            },
            onBackupExportRequested = {
                backupExporter.launch("plate-backup-${System.currentTimeMillis()}.zip")
            },
            onBackupImportRequested = {
                backupImporter.launch(arrayOf("application/zip", "application/x-zip-compressed"))
            },
            onPrimaryActionLabelsChanged = { manual, barcode, photo ->
                // JavaScript-interface calls are not made on the UI thread.
                runOnUiThread { updatePrimaryActionLabels(manual, barcode, photo) }
            },
        )
        val root = FrameLayout(this)
        root.addView(plateWebView, FrameLayout.LayoutParams(
            FrameLayout.LayoutParams.MATCH_PARENT,
            FrameLayout.LayoutParams.MATCH_PARENT,
        ))
        root.addView(nativeActionBar(), FrameLayout.LayoutParams(
            FrameLayout.LayoutParams.MATCH_PARENT,
            FrameLayout.LayoutParams.WRAP_CONTENT,
            Gravity.BOTTOM,
        ))
        setContentView(root)
    }

    /**
     * The PWA's 3D deck animation can make a fixed DOM bar blink in WebView.
     * This small native sibling keeps the exact three entry points stable while
     * delegating their actual behaviour back to the packaged PWA.
     */
    private fun nativeActionBar(): View = LinearLayout(this).apply {
        orientation = LinearLayout.HORIZONTAL
        gravity = Gravity.CENTER
        setPadding(dp(12), dp(8), dp(12), dp(10))
        setBackgroundColor(Color.rgb(250, 246, 239))
        elevation = dp(8).toFloat()

        manualAction = actionButton("Manual", R.drawable.ic_action_manual, false, "manual")
        barcodeAction = actionButton("Barcode", R.drawable.ic_action_barcode, false, "barcode")
        photoAction = actionButton("Photo", R.drawable.ic_action_photo, true, "photo")
        addView(manualAction, actionLayoutParams())
        addView(barcodeAction, actionLayoutParams())
        addView(photoAction, actionLayoutParams())
    }

    private fun actionLayoutParams() = LinearLayout.LayoutParams(0, dp(64), 1f).apply {
        marginStart = dp(4)
        marginEnd = dp(4)
    }

    private fun actionButton(label: String, icon: Int, primary: Boolean, action: String): Button = Button(this).apply {
        text = label
        textSize = 12f
        isAllCaps = false
        gravity = Gravity.CENTER
        setTextColor(if (primary) Color.WHITE else Color.rgb(74, 87, 76))
        compoundDrawablePadding = dp(2)
        val image = getDrawable(icon)?.mutate()?.apply { setTint(if (primary) Color.WHITE else Color.rgb(74, 87, 76)) }
        setCompoundDrawablesWithIntrinsicBounds(null, image, null, null)
        background = GradientDrawable().apply {
            setColor(if (primary) Color.rgb(46, 139, 87) else Color.WHITE)
            cornerRadius = dp(16).toFloat()
            setStroke(dp(1), if (primary) Color.rgb(35, 111, 68) else Color.rgb(232, 224, 210))
        }
        minWidth = 0
        minHeight = 0
        setPadding(dp(4), dp(4), dp(4), dp(4))
        setOnClickListener { plateWebView.performPrimaryAction(action) }
    }

    private fun updatePrimaryActionLabels(manual: String, barcode: String, photo: String) {
        // A WebView page can finish loading while Android restores an activity.
        // The buttons are already added before its scripts send this message.
        manualAction.text = manual
        barcodeAction.text = barcode
        photoAction.text = photo
    }

    private fun dp(value: Int): Int = (value * resources.displayMetrics.density).toInt()
}
