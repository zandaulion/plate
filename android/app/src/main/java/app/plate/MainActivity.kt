package com.zandaulion.bitey

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
import androidx.activity.OnBackPressedCallback
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
    private lateinit var backCallback: OnBackPressedCallback
    private var backRequestInFlight = false

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
        backCallback = object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                // evaluateJavascript returns asynchronously. Ignore a second
                // gesture until the page has either unwound its top screen or
                // told us that the day view is already at its root.
                if (backRequestInFlight) return
                backRequestInFlight = true
                plateWebView.navigateBack { handled ->
                    backRequestInFlight = false
                    if (handled) return@navigateBack

                    // No app screen remains. Hand this one gesture back to
                    // Android so its normal root-screen behavior still works.
                    isEnabled = false
                    onBackPressedDispatcher.onBackPressed()
                    isEnabled = true
                }
            }
        }
        onBackPressedDispatcher.addCallback(this, backCallback)
        setContentView(root)
    }

    /**
     * The PWA's 3D deck animation can make a fixed DOM bar blink in WebView.
     * This small native sibling keeps the exact three entry points stable while
     * delegating their actual behaviour back to the packaged PWA.
     */
    private fun nativeActionBar(): View = FrameLayout(this).apply {
        setBackgroundColor(Color.rgb(250, 246, 239))
        elevation = dp(8).toFloat()

        val rail = LinearLayout(this@MainActivity).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER
            setPadding(dp(if (isTablet) 16 else 12), dp(8), dp(if (isTablet) 16 else 12), dp(10))

            manualAction = actionButton("Manual", R.drawable.ic_action_manual, false, "manual")
            barcodeAction = actionButton("Barcode", R.drawable.ic_action_barcode, false, "barcode")
            photoAction = actionButton("Photo", R.drawable.ic_action_photo_locked, true, "photo", locked = true)
            addView(manualAction, actionLayoutParams())
            addView(barcodeAction, actionLayoutParams())
            addView(photoAction, actionLayoutParams())
        }
        addView(rail, FrameLayout.LayoutParams(actionRailWidth(), FrameLayout.LayoutParams.WRAP_CONTENT, Gravity.CENTER_HORIZONTAL))
    }

    private val isTablet: Boolean
        get() = resources.configuration.smallestScreenWidthDp >= 600

    private fun actionRailWidth(): Int {
        if (!isTablet) return FrameLayout.LayoutParams.MATCH_PARENT
        // A 600dp portrait tablet still needs side gutters, while a wide
        // landscape display should not turn the three actions into a runway.
        return dp(minOf(960, (resources.configuration.screenWidthDp - 48).coerceAtLeast(0)))
    }

    private fun actionLayoutParams() = LinearLayout.LayoutParams(0, dp(if (isTablet) 72 else 64), 1f).apply {
        marginStart = dp(if (isTablet) 6 else 4)
        marginEnd = dp(if (isTablet) 6 else 4)
    }

    private fun actionButton(label: String, icon: Int, primary: Boolean, action: String, locked: Boolean = false): Button = Button(this).apply {
        text = label
        textSize = if (isTablet) 14f else 12f
        isAllCaps = false
        gravity = Gravity.CENTER
        setTextColor(if (primary) Color.WHITE else Color.rgb(74, 87, 76))
        compoundDrawablePadding = dp(2)
        // The locked photo drawable carries its own two colours: the lock sits
        // on an accent-coloured cutout over the camera. Tinting it would flatten
        // that into an indistinct blob.
        val image = getDrawable(icon)?.mutate()?.apply {
            if (!locked) setTint(if (primary) Color.WHITE else Color.rgb(74, 87, 76))
        }
        setCompoundDrawablesWithIntrinsicBounds(null, image, null, null)
        background = GradientDrawable().apply {
            setColor(if (primary) Color.rgb(46, 139, 87) else Color.WHITE)
            cornerRadius = dp(if (isTablet) 18 else 16).toFloat()
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
