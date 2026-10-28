package com.codassol.mobile

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.GestureDescription
import android.graphics.Bitmap
import android.graphics.Path
import android.os.Handler
import android.os.Looper
import android.view.Display
import android.view.accessibility.AccessibilityEvent
import android.util.Base64
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.math.roundToInt

class PhoneAccessibility : AccessibilityService() {
    companion object { @Volatile var current: PhoneAccessibility? = null }
    private val main = Handler(Looper.getMainLooper())
    @Volatile private var testPackage: String? = null
    override fun onServiceConnected() { current = this }
    override fun onAccessibilityEvent(event: AccessibilityEvent?) { current = this }
    override fun onUnbind(intent: android.content.Intent?): Boolean { if (current === this) current = null; return super.onUnbind(intent) }
    override fun onInterrupt() {}
    override fun onDestroy() { if (current === this) current = null; super.onDestroy() }
    private fun guard(session: Long, expires: Long) {
        AgentState.check(session, expires)
        check(!getSystemService(android.app.KeyguardManager::class.java).isKeyguardLocked) { "UNLOCK_PHONE_REQUIRED" }
    }
    private fun protectedPackage(value: String) = value == packageName || value.contains("permissioncontroller") ||
        value.contains("packageinstaller") || value.contains("settings") || value.contains("systemui")
    fun launch(target: String, session: Long, expires: Long) {
        require(!protectedPackage(target)) { "SYSTEM_DIALOG_REQUIRES_USER" }
        val intent = packageManager.getLaunchIntentForPackage(target) ?: throw IllegalArgumentException("APP_NOT_FOUND")
        val done = CountDownLatch(1); val active = AtomicBoolean(true); var failure: Exception? = null
        main.post {
            try { guard(session, expires); check(active.get()) { "LAUNCH_TIMEOUT" }; startActivity(intent.addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK)); testPackage = target }
            catch (e: Exception) { failure = e } finally { done.countDown() }
        }
        val completed = done.await(3, TimeUnit.SECONDS); active.set(false)
        check(completed) { "LAUNCH_TIMEOUT" }; failure?.let { throw it }
    }
    fun gesture(args: JSONObject, session: Long, expires: Long) {
        val done = CountDownLatch(1); val active = AtomicBoolean(true); var failure: Exception? = null
        main.post {
            try {
                guard(session, expires)
                val foreground = rootInActiveWindow?.packageName?.toString() ?: throw IllegalStateException("FOREGROUND_UNKNOWN")
                require(foreground == testPackage && !protectedPackage(foreground)) { "LAUNCH_TEST_APP_FIRST" }
                val metrics = getSystemService(android.hardware.display.DisplayManager::class.java).getDisplay(Display.DEFAULT_DISPLAY)
                val size = android.graphics.Point(); metrics.getRealSize(size)
                fun coordinate(key: String, bound: Int): Float {
                    val value = args.getDouble(key); require(value.isFinite() && value >= 0 && value < bound) { "COORDINATE_OUT_OF_BOUNDS" }
                    return value.toFloat()
                }
                val path = Path().apply { moveTo(coordinate("x",size.x), coordinate("y",size.y)) }
                val swipe = args.getString("action") == "swipe"
                if (swipe) path.lineTo(coordinate("endX",size.x), coordinate("endY",size.y))
                val duration = if (swipe) args.optLong("durationMs",300) else 50L
                require(duration in 1..1500) { "INVALID_GESTURE_DURATION" }
                if (!active.get()) throw IllegalStateException("GESTURE_TIMEOUT")
                val gesture = GestureDescription.Builder().addStroke(GestureDescription.StrokeDescription(path,0,duration)).build()
                check(dispatchGesture(gesture, object : GestureResultCallback() {
                    override fun onCompleted(description: GestureDescription?) { done.countDown() }
                    override fun onCancelled(description: GestureDescription?) { failure = IllegalStateException("GESTURE_CANCELLED"); done.countDown() }
                }, main)) { "GESTURE_REJECTED" }
            } catch (e: Exception) { failure = e; done.countDown() }
        }
        val completed = done.await(4, TimeUnit.SECONDS); active.set(false)
        check(completed) { "GESTURE_TIMEOUT" }; failure?.let { throw it }; guard(session,expires)
    }
    fun capture(session: Long, expires: Long): Pair<JSONObject,String> {
        val done = CountDownLatch(1); val active = AtomicBoolean(true)
        var failure: Exception? = null; var result: Pair<JSONObject,String>? = null
        main.post {
            try {
                guard(session,expires)
                takeScreenshot(Display.DEFAULT_DISPLAY, mainExecutor, object : TakeScreenshotCallback {
                    override fun onSuccess(shot: ScreenshotResult) {
                        try {
                            guard(session,expires)
                            if (!active.get()) return
                            val hardware = Bitmap.wrapHardwareBuffer(shot.hardwareBuffer,shot.colorSpace) ?: error("SCREENSHOT_UNAVAILABLE")
                            try {
                                val bitmap = hardware.copy(Bitmap.Config.ARGB_8888,false)
                                try {
                                    val scale = minOf(1.0,1280.0/maxOf(bitmap.width,bitmap.height))
                                    val scaled = Bitmap.createScaledBitmap(bitmap,(bitmap.width*scale).roundToInt(),(bitmap.height*scale).roundToInt(),true)
                                    try {
                                        val out = ByteArrayOutputStream(); scaled.compress(Bitmap.CompressFormat.JPEG,75,out)
                                        result = JSONObject().put("display_width",bitmap.width).put("display_height",bitmap.height)
                                            .put("image_width",scaled.width).put("image_height",scaled.height)
                                            .put("foreground_package",rootInActiveWindow?.packageName?.toString() ?: JSONObject.NULL) to
                                            Base64.encodeToString(out.toByteArray(),Base64.NO_WRAP)
                                    } finally { if (scaled !== bitmap) scaled.recycle() }
                                } finally { bitmap.recycle() }
                            } finally { hardware.recycle() }
                        } catch (e: Exception) { failure = e }
                        finally { shot.hardwareBuffer.close(); done.countDown() }
                    }
                    override fun onFailure(errorCode: Int) { failure = IllegalStateException("SCREENSHOT_ERROR_$errorCode"); done.countDown() }
                })
            } catch(e: Exception) { failure = e; done.countDown() }
        }
        val completed = done.await(5,TimeUnit.SECONDS); active.set(false)
        check(completed) { "SCREENSHOT_TIMEOUT" }; failure?.let { throw it }; guard(session,expires)
        return result ?: throw IllegalStateException("SCREENSHOT_UNAVAILABLE")
    }
}
