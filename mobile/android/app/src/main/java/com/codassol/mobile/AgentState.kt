package com.codassol.mobile

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import org.json.JSONObject
import java.security.KeyStore
import java.util.UUID
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

object AgentState {
    @Volatile var enabled = false
        private set
    @Volatile var generation = 0L
        private set
    @Volatile var enabledAt = 0L
        private set
    @Volatile var status = "访问已关闭"
    @Volatile var lastAction = "尚无手机操作"
    @Volatile var connected = false
        private set
    @Synchronized fun enable(): Long { generation++; enabledAt = System.currentTimeMillis(); enabled = true; return generation }
    @Synchronized fun disable() { enabled = false; generation++; connected = false; status = "访问已关闭" }
    @Synchronized fun connect(session: Long): Boolean {
        if (!enabled || generation != session) return false
        connected = true; return true
    }
    @Synchronized fun disconnect(session: Long): Boolean {
        if (!enabled || generation != session) return false
        connected = false; return true
    }
    fun check(session: Long, expires: Long = System.currentTimeMillis() + 1000) =
        Protocol.checkJob(enabled, generation, session, expires, System.currentTimeMillis())
}

class PhoneStore(private val context: Context) {
    private val prefs = context.getSharedPreferences("codas-phone", Context.MODE_PRIVATE)
    val deviceId: String = prefs.getString("device", null) ?: ("android-" + UUID.randomUUID()).also {
        check(prefs.edit().putString("device", it).commit())
    }
    val workspaceId get() = "ws_" + deviceId.replace('-', '_')
    var endpoint: String
        get() = prefs.getString("endpoint", "")!!
        set(value) {
            val clean = Protocol.endpoint(value)
            if (clean != endpoint) { check(prefs.edit().remove("credential").putString("endpoint", clean).commit()) }
        }
    private fun bootCount() = android.provider.Settings.Global.getInt(context.contentResolver, android.provider.Settings.Global.BOOT_COUNT, -1)
    fun accessRequested() = prefs.getBoolean("access_requested", false) && bootCount() >= 0 && prefs.getInt("access_boot", -2) == bootCount()
    fun requestAccess(enabled: Boolean) {
        check(prefs.edit().putBoolean("access_requested", enabled).putInt("access_boot", bootCount()).commit())
    }
    private fun key(): SecretKey {
        val ks = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        return (ks.getKey("codas-phone-agent", null) as? SecretKey) ?: KeyGenerator.getInstance("AES", "AndroidKeyStore").apply {
            init(KeyGenParameterSpec.Builder("codas-phone-agent", KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build())
        }.generateKey()
    }
    fun token(): String? {
        val saved = prefs.getString("credential", null) ?: return null
        val parts = saved.split(":")
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, Base64.decode(parts[0], Base64.NO_WRAP)))
        return String(cipher.doFinal(Base64.decode(parts[1], Base64.NO_WRAP)), Charsets.UTF_8)
    }
    fun saveToken(token: String) {
        require(token.length in 20..4096)
        val cipher = Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.ENCRYPT_MODE, key()) }
        val value = Base64.encodeToString(cipher.iv, Base64.NO_WRAP) + ":" + Base64.encodeToString(cipher.doFinal(token.toByteArray()), Base64.NO_WRAP)
        check(prefs.edit().putString("credential", value).commit())
    }
    @Synchronized fun acceptJob(id: String): Boolean {
        if (id.isBlank() || id.length > 160) return false
        val ids = prefs.getString("seen", "")!!.split("\n").filter { it.isNotBlank() }
        if (id in ids || id.contains('\n')) return false
        check(prefs.edit().putString("seen", (ids + id).takeLast(256).joinToString("\n")).commit())
        return true
    }
    fun metadata() = JSONObject().put("id", deviceId).put("label", android.os.Build.MODEL)
        .put("platform", "android").put("roots", org.json.JSONArray().put("/codas/android"))
        .put("capabilities", org.json.JSONArray().put("devspace-http").put("android-native-v1"))
}
