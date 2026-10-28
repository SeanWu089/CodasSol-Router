package com.codassol.mobile

import android.app.*
import android.content.Intent
import android.os.IBinder
import android.os.Build
import android.content.pm.ServiceInfo
import org.json.JSONObject
import java.io.BufferedReader
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import kotlin.math.min

class AgentService : Service() {
    companion object {
        const val STOP = "com.codassol.mobile.STOP"
        @Volatile var current: AgentService? = null
    }
    private val workers = Executors.newScheduledThreadPool(2)
    private val connections = ConcurrentHashMap.newKeySet<HttpURLConnection>()
    private lateinit var store: PhoneStore
    private var session = -1L
    @Volatile private var lastPositive = 0L
    override fun onBind(intent: Intent?): IBinder? = null
    override fun onCreate() {
        super.onCreate(); current = this; store = PhoneStore(this)
        val nm = getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(NotificationChannel("codas-access", "Codas 手机访问", NotificationManager.IMPORTANCE_LOW))
    }
    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == STOP) { disable(); return START_NOT_STICKY }
        if (session >= 0) return START_NOT_STICKY
        session = AgentState.enable()
        val notification = notification("无线访问已开启；点此查看状态")
        if (Build.VERSION.SDK_INT >= 34) startForeground(1, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
        else startForeground(1, notification)
        var pairing = intent?.getStringExtra("pairing") ?: ""
        intent?.removeExtra("pairing")
        workers.execute {
            try {
                var token = store.token()
                if (token == null) {
                    require(pairing.isNotBlank()) { "PAIRING_REQUIRED" }
                    val enrolled = json("/enroll", pairing, store.metadata())
                    AgentState.check(session)
                    require(enrolled.getString("deviceId") == store.deviceId) { "DEVICE_ID_MISMATCH" }
                    token = enrolled.getString("agentToken"); store.saveToken(token)
                }
                pairing = ""
                val credential = token!!
                workers.scheduleWithFixedDelay({
                    try {
                        if (AgentState.enabled && AgentState.generation == session && AgentState.connected &&
                            System.currentTimeMillis() - lastPositive >= 30 * 60_000) {
                            json("/heartbeat", credential, store.metadata()); lastPositive = System.currentTimeMillis()
                        }
                    } catch (_: Exception) { connections.forEach { it.disconnect() } }
                }, 30, 30, TimeUnit.SECONDS)
                var failures = 0
                while (AgentState.enabled && AgentState.generation == session) {
                    var readyAt = 0L
                    try {
                        AgentState.status = "连接中"
                        val connection = connection("/events", credential).apply {
                            readTimeout = 65_000; setRequestProperty("Accept", "text/event-stream")
                        }
                        try {
                            checkStatus(connection)
                            require(connection.contentType?.startsWith("text/event-stream") == true) { "INVALID_STREAM" }
                            Protocol.consume(BufferedReader(connection.inputStream.reader(Charsets.UTF_8))) { type, data ->
                                AgentState.check(session)
                                when (type) {
                                    "ready" -> {
                                        val ready = JSONObject(data)
                                        require(ready.getString("deviceId") == store.deviceId && ready.getInt("protocol") == 1) { "PROTOCOL_MISMATCH" }
                                        readyAt = System.currentTimeMillis(); lastPositive = readyAt
                                        AgentState.connected = true; AgentState.status = "已连接 · 可接收手机任务"
                                    }
                                    "job" -> {
                                        require(readyAt > 0) { "MISSING_READY" }
                                        val job = JSONObject(data).getJSONObject("job")
                                        val id = job.getString("id")
                                        val result = JSONObject().put("jobId", id)
                                        try {
                                            AgentState.check(session, job.getLong("expiresAt"))
                                            Protocol.checkCreatedAt(job.getLong("createdAt"), AgentState.enabledAt, job.getLong("expiresAt"))
                                            require(store.acceptJob(id)) { "DUPLICATE_JOB" }
                                            result.put("ok", true).put("result", PhoneCommands(this, store, session, job.getLong("expiresAt")).execute(job.getJSONObject("payload")))
                                        } catch (e: Exception) {
                                            result.put("ok", false).put("error", JSONObject().put("code", "PHONE_OPERATION_REJECTED").put("message", safeError(e)))
                                        }
                                        AgentState.check(session)
                                        json("/result", credential, result); lastPositive = System.currentTimeMillis(); failures = 0
                                    }
                                }
                            }
                            throw IllegalStateException("STREAM_CLOSED")
                        } finally { connections.remove(connection); connection.disconnect() }
                    } catch (e: Exception) {
                        AgentState.connected = false
                        if (!AgentState.enabled || AgentState.generation != session) break
                        if (e is Rejected && e.status in listOf(401,403,404,409)) throw e
                        failures = if (readyAt > 0 && System.currentTimeMillis() - readyAt >= 60_000) 1 else min(failures + 1, 6)
                        AgentState.status = "网络中断，等待重连"
                        Thread.sleep(min(60_000L, 1000L shl failures))
                    }
                }
            } catch (e: Exception) {
                if (AgentState.generation == session) {
                    val error = safeError(e); disable(); AgentState.status = "连接停止：$error"
                }
            }
        }
        return START_NOT_STICKY
    }
    private class Rejected(val status: Int) : Exception("HTTP_$status")
    private fun checkStatus(c: HttpURLConnection) { if (c.responseCode !in 200..299) throw Rejected(c.responseCode) }
    private fun connection(path: String, token: String): HttpURLConnection {
        AgentState.check(session)
        return (URL(store.endpoint + "/_codassol/agent" + path).openConnection() as HttpURLConnection).apply {
            instanceFollowRedirects = false; connectTimeout = 15_000; readTimeout = 15_000
            setRequestProperty("Authorization", "Bearer $token"); setRequestProperty("Cache-Control", "no-cache")
            connections.add(this)
        }
    }
    private fun json(path: String, token: String, body: JSONObject): JSONObject {
        val c = connection(path, token)
        try {
            c.requestMethod = "POST"; c.doOutput = true; c.setRequestProperty("Content-Type", "application/json")
            c.outputStream.use { it.write(body.toString().toByteArray()) }; checkStatus(c)
            val bytes = c.inputStream.use { input ->
                val out = java.io.ByteArrayOutputStream(); val buffer = ByteArray(8192)
                while (out.size() <= 1_048_576) { val n = input.read(buffer); if (n < 0) break; out.write(buffer,0,n) }
                out.toByteArray()
            }
            require(bytes.size <= 1_048_576) { "RESPONSE_TOO_LARGE" }
            return JSONObject(String(bytes, Charsets.UTF_8))
        } finally { connections.remove(c); c.disconnect() }
    }
    fun disable() {
        if (session < 0 || AgentState.generation == session) AgentState.disable()
        connections.forEach { it.disconnect() }; workers.shutdownNow()
        ApkOperations.cancel(this)
        stopForeground(STOP_FOREGROUND_REMOVE); stopSelf()
    }
    private fun notification(text: String): Notification {
        val open = PendingIntent.getActivity(this, 0, Intent(this, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE)
        val stop = PendingIntent.getService(this, 1, Intent(this, AgentService::class.java).setAction(STOP), PendingIntent.FLAG_IMMUTABLE)
        return Notification.Builder(this, "codas-access").setSmallIcon(R.drawable.ic_codassol)
            .setContentTitle("Codas 手机访问已开启").setContentText(text).setContentIntent(open).setOngoing(true)
            .addAction(Notification.Action.Builder(null, "关闭访问", stop).build()).build()
    }
    override fun onDestroy() {
        if (AgentState.generation == session) AgentState.disable()
        connections.forEach { it.disconnect() }; workers.shutdownNow()
        if (current === this) current = null
        super.onDestroy()
    }
}

fun safeError(e: Throwable): String = when (e) {
    is java.net.SocketTimeoutException -> "NETWORK_TIMEOUT"
    is java.net.UnknownHostException -> "DNS_FAILED"
    is javax.net.ssl.SSLException -> "TLS_FAILED"
    else -> e.message?.takeIf { it.matches(Regex("[A-Z][A-Z_0-9]{2,80}")) } ?: e.javaClass.simpleName
}
