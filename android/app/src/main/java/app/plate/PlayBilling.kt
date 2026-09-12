package com.zandaulion.bitey

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.net.Uri
import com.android.billingclient.api.AcknowledgePurchaseParams
import com.android.billingclient.api.BillingClient
import com.android.billingclient.api.BillingClientStateListener
import com.android.billingclient.api.BillingFlowParams
import com.android.billingclient.api.BillingResult
import com.android.billingclient.api.PendingPurchasesParams
import com.android.billingclient.api.ProductDetails
import com.android.billingclient.api.Purchase
import com.android.billingclient.api.PurchasesUpdatedListener
import com.android.billingclient.api.QueryProductDetailsParams
import com.android.billingclient.api.QueryPurchasesParams
import org.json.JSONArray
import org.json.JSONObject

/**
 * The Play side of Bitey AI access.
 *
 * There is deliberately no account identifier here: Bitey has no account
 * system and should not manufacture one just for payments. Google Play owns
 * the purchase and [refresh] restores it for the Play account on this device.
 *
 * This is the client half of the eventual paid AI flow. It never sends a photo
 * or diary data to Play. Once Gemini is enabled, the Firebase endpoint must
 * verify the purchase token before it spends model quota; a client result is
 * useful for the interface, but is not a sufficient server-side authorisation.
 */
class PlayBilling(
    private val context: Context,
    private val onEntitlementChanged: (Status) -> Unit = {},
) : PurchasesUpdatedListener {
    companion object {
        /** Create this subscription product in Play Console before enabling it. */
        const val AI_SUBSCRIPTION_ID = "bitey_ai"
        const val MONTHLY_BASE_PLAN_ID = "monthly"
        const val YEARLY_BASE_PLAN_ID = "yearly"
        private val BASE_PLAN_ORDER = listOf(MONTHLY_BASE_PLAN_ID, YEARLY_BASE_PLAN_ID)
    }

    enum class Status(val wireValue: String) {
        ACTIVE("active"),
        INACTIVE("inactive"),
        PENDING("pending"),
        UNAVAILABLE("unavailable"),
        CANCELLED("cancelled"),
        ERROR("error"),
    }

    data class Offer(val basePlanId: String, val formattedPrice: String)

    /** The WebView receives only opaque plan IDs and Play-localised prices.
     * A purchase re-queries ProductDetails, so it never launches against a
     * stale object or exposes an offer token to page code. */
    sealed class AccessResponse {
        abstract fun toJson(): String

        data class Entitlement(val status: Status) : AccessResponse() {
            override fun toJson(): String = JSONObject()
                .put("status", status.wireValue)
                .toString()
        }

        data class Offers(val offers: List<Offer>) : AccessResponse() {
            override fun toJson(): String = JSONObject()
                .put("status", "offers")
                .put("offers", JSONArray().apply {
                    offers.forEach { offer ->
                        put(JSONObject()
                            .put("id", offer.basePlanId)
                            .put("price", offer.formattedPrice))
                    }
                })
                .toString()
        }
    }

    private val readyCallbacks = mutableListOf<(Boolean) -> Unit>()
    private val accessCallbacks = mutableListOf<(Status) -> Unit>()
    private var connecting = false
    private var purchaseFlowInFlight = false
    private var entitlement = Status.INACTIVE

    private val billingClient: BillingClient = BillingClient.newBuilder(context)
        .setListener(this)
        // Required by current Billing Library releases. Bitey presently sells a
        // subscription, but enabling pending one-time products keeps the
        // client safe if a future credit pack is introduced.
        .enablePendingPurchases(
            PendingPurchasesParams.newBuilder()
                .enableOneTimeProducts()
                .build(),
        )
        .enableAutoServiceReconnection()
        .build()

    fun start() {
        refresh()
    }

    /** Query Play whenever the app returns to the foreground. This restores a
     * purchase made elsewhere and catches a pending purchase that completed
     * while Bitey was closed. */
    fun refresh(callback: ((Status) -> Unit)? = null) {
        ensureConnected { connected ->
            if (!connected) {
                setEntitlement(Status.UNAVAILABLE)
                callback?.invoke(Status.UNAVAILABLE)
                return@ensureConnected
            }
            val params = QueryPurchasesParams.newBuilder()
                .setProductType(BillingClient.ProductType.SUBS)
                .build()
            billingClient.queryPurchasesAsync(params) { result, purchases ->
                if (result.responseCode != BillingClient.BillingResponseCode.OK) {
                    callback?.invoke(Status.ERROR)
                    return@queryPurchasesAsync
                }
                val next = statusFor(purchases)
                setEntitlement(next)
                callback?.invoke(next)
            }
        }
    }

    /**
     * Checks the restored entitlement first. If it is not active, the current
     * Play product details are fetched immediately before the purchase sheet is
     * launched; ProductDetails are intentionally never cached.
     */
    fun requestAiAccess(callback: (AccessResponse) -> Unit) {
        when (entitlement) {
            Status.ACTIVE, Status.PENDING -> {
                callback(AccessResponse.Entitlement(entitlement))
                return
            }
            else -> Unit
        }
        refresh { restored ->
            when (restored) {
                Status.ACTIVE, Status.PENDING -> callback(AccessResponse.Entitlement(restored))
                Status.INACTIVE -> queryPurchaseOptions(callback)
                else -> callback(AccessResponse.Entitlement(restored))
            }
        }
    }

    /** Starts the Play sheet only after the person explicitly chooses one of
     * the fresh, eligible plans shown in the packaged interface. */
    fun buyAiOffer(activity: Activity, basePlanId: String, callback: (AccessResponse) -> Unit) {
        if (basePlanId !in BASE_PLAN_ORDER) {
            callback(AccessResponse.Entitlement(Status.ERROR))
            return
        }
        accessCallbacks += { status -> callback(AccessResponse.Entitlement(status)) }
        if (purchaseFlowInFlight) return
        purchaseFlowInFlight = true
        refresh { restored ->
            when (restored) {
                Status.ACTIVE, Status.PENDING -> finishAccess(restored)
                Status.INACTIVE -> queryAndLaunchPurchase(activity, basePlanId)
                else -> finishAccess(restored)
            }
        }
    }

    /** Opens the standard Google Play subscription management page. */
    fun manageSubscription(activity: Activity) {
        val uri = Uri.parse(
            "https://play.google.com/store/account/subscriptions" +
                "?package=${context.packageName}&sku=$AI_SUBSCRIPTION_ID",
        )
        runCatching {
            activity.startActivity(Intent(Intent.ACTION_VIEW, uri))
        }.onFailure {
            setEntitlement(Status.ERROR)
        }
    }

    fun close() {
        readyCallbacks.clear()
        if (accessCallbacks.isNotEmpty()) finishAccess(Status.ERROR)
        billingClient.endConnection()
    }

    override fun onPurchasesUpdated(result: BillingResult, purchases: List<Purchase>?) {
        when (result.responseCode) {
            BillingClient.BillingResponseCode.OK -> {
                val next = statusFor(purchases.orEmpty())
                setEntitlement(next)
                if (purchaseFlowInFlight) finishAccess(next)
            }
            BillingClient.BillingResponseCode.USER_CANCELED -> {
                if (purchaseFlowInFlight) finishAccess(Status.CANCELLED)
            }
            else -> {
                if (purchaseFlowInFlight) finishAccess(Status.ERROR)
            }
        }
    }

    private fun ensureConnected(whenReady: (Boolean) -> Unit) {
        if (billingClient.isReady) {
            whenReady(true)
            return
        }
        readyCallbacks += whenReady
        if (connecting) return
        connecting = true
        billingClient.startConnection(object : BillingClientStateListener {
            override fun onBillingSetupFinished(result: BillingResult) {
                connecting = false
                if (result.responseCode != BillingClient.BillingResponseCode.OK) {
                    val callbacks = readyCallbacks.toList()
                    readyCallbacks.clear()
                    callbacks.forEach { it(false) }
                    return
                }
                val callbacks = readyCallbacks.toList()
                readyCallbacks.clear()
                callbacks.forEach { it(true) }
            }

            // enableAutoServiceReconnection() handles the next API call. Do
            // not spin a manual reconnection loop here.
            override fun onBillingServiceDisconnected() = Unit
        })
    }

    private fun queryPurchaseOptions(callback: (AccessResponse) -> Unit) {
        queryAiProduct { result, product ->
            if (result.responseCode != BillingClient.BillingResponseCode.OK || product == null) {
                callback(AccessResponse.Entitlement(Status.UNAVAILABLE))
                return@queryAiProduct
            }
            val offers = product.subscriptionOfferDetails.orEmpty()
                .asSequence()
                // A base plan is what we are deliberately selling at launch;
                // free trials and other future offers will be modelled
                // explicitly, not accidentally selected by list order.
                .filter { it.offerId == null && it.basePlanId in BASE_PLAN_ORDER }
                .mapNotNull { offer ->
                    val price = offer.pricingPhases.pricingPhaseList.lastOrNull()?.formattedPrice
                    price?.let { Offer(offer.basePlanId, it) }
                }
                .distinctBy(Offer::basePlanId)
                .sortedBy { BASE_PLAN_ORDER.indexOf(it.basePlanId) }
                .toList()
            if (offers.isEmpty()) callback(AccessResponse.Entitlement(Status.UNAVAILABLE))
            else callback(AccessResponse.Offers(offers))
        }
    }

    private fun queryAndLaunchPurchase(activity: Activity, basePlanId: String) {
        queryAiProduct { result, product ->
            if (result.responseCode != BillingClient.BillingResponseCode.OK || product == null) {
                finishAccess(Status.UNAVAILABLE)
                return@queryAiProduct
            }
            val offer = product.subscriptionOfferDetails.orEmpty()
                .firstOrNull { it.offerId == null && it.basePlanId == basePlanId }
            if (offer == null) {
                // The offer can change between displaying the plans and this
                // click. Never substitute a different plan silently.
                finishAccess(Status.UNAVAILABLE)
                return@queryAiProduct
            }
            launchPurchase(activity, product, offer.offerToken)
        }
    }

    private fun queryAiProduct(callback: (BillingResult, ProductDetails?) -> Unit) {
        val params = QueryProductDetailsParams.newBuilder()
            .setProductList(
                listOf(
                    QueryProductDetailsParams.Product.newBuilder()
                        .setProductId(AI_SUBSCRIPTION_ID)
                        .setProductType(BillingClient.ProductType.SUBS)
                        .build(),
                ),
            )
            .build()
        billingClient.queryProductDetailsAsync(params) { result, queryResult ->
            val product = queryResult.productDetailsList
                .firstOrNull { it.productId == AI_SUBSCRIPTION_ID }
            callback(result, product)
        }
    }

    private fun launchPurchase(activity: Activity, product: ProductDetails, offerToken: String) {
        val params = BillingFlowParams.newBuilder()
            .setProductDetailsParamsList(
                listOf(
                    BillingFlowParams.ProductDetailsParams.newBuilder()
                        .setProductDetails(product)
                        .setOfferToken(offerToken)
                        .build(),
                ),
            )
            // Prices are never personalised by Bitey.
            .setIsOfferPersonalized(false)
            .build()
        val result = billingClient.launchBillingFlow(activity, params)
        if (result.responseCode != BillingClient.BillingResponseCode.OK) {
            finishAccess(Status.ERROR)
        }
    }

    private fun statusFor(purchases: List<Purchase>): Status {
        val matching = purchases.filter { AI_SUBSCRIPTION_ID in it.products }
        val purchased = matching.firstOrNull {
            it.purchaseState == Purchase.PurchaseState.PURCHASED
        }
        if (purchased != null) {
            acknowledgeIfNeeded(purchased)
            return Status.ACTIVE
        }
        if (matching.any { it.purchaseState == Purchase.PurchaseState.PENDING }) {
            return Status.PENDING
        }
        return Status.INACTIVE
    }

    private fun acknowledgeIfNeeded(purchase: Purchase) {
        if (purchase.isAcknowledged) return
        val params = AcknowledgePurchaseParams.newBuilder()
            .setPurchaseToken(purchase.purchaseToken)
            .build()
        billingClient.acknowledgePurchase(params) { /* Refresh handles retry. */ }
    }

    private fun setEntitlement(next: Status) {
        if (entitlement == next) return
        entitlement = next
        onEntitlementChanged(next)
    }

    private fun finishAccess(result: Status) {
        purchaseFlowInFlight = false
        val callbacks = accessCallbacks.toList()
        accessCallbacks.clear()
        callbacks.forEach { it(result) }
    }
}
