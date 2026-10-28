package com.codassol.mobile

import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInstaller
import android.os.Build
import org.json.JSONObject
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest
import java.util.UUID
import java.util.concurrent.Executors

object ApkOperations {
    private val worker = Executors.newSingleThreadExecutor()
    @Volatile private var state = JSONObject().put("status", "idle")
    @Volatile private var operationSession = -1L
    @Volatile private var installSession = -1
    @Volatile private var pending: Intent? = null
    @Volatile private var connection: HttpURLConnection? = null
    private var file: File? = null
    @Synchronized private fun update(status: String, error: String? = null) {
        state = JSONObject(state.toString()).put("status",status)
        if (error != null) state.put("error",error)
    }
    @Synchronized fun snapshot(context: Context): JSONObject {
        val result = JSONObject(state.toString())
        result.put("install_permission",context.packageManager.canRequestPackageInstalls())
        return result
    }
    private fun https(value: String): URL {
        val uri = java.net.URI(value)
        require(uri.scheme == "https" && uri.host != null && uri.userInfo == null && uri.fragment == null) { "APK_HTTPS_REQUIRED" }
        return uri.toURL()
    }
    @Synchronized fun download(context: Context, args: JSONObject, session: Long, selfUpdate: Boolean = false): JSONObject {
        AgentState.check(session)
        require(state.optString("status") !in listOf("downloading","ready_to_install","installing","awaiting_confirmation")) { "INSTALL_ALREADY_ACTIVE" }
        val url = https(args.getString("url"))
        val hash = args.getString("sha256").lowercase()
        require(hash.matches(Regex("[a-f0-9]{64}"))) { "APK_SHA256_REQUIRED" }
        val target = args.getString("package")
        require((selfUpdate || target != context.packageName) && target.matches(Regex("[a-zA-Z][a-zA-Z0-9_]*(\\.[a-zA-Z0-9_]+)+"))) { "INVALID_PACKAGE" }
        require(!selfUpdate || target == context.packageName) { "INVALID_AGENT_UPDATE_TARGET" }
        val id = UUID.randomUUID().toString()
        state = JSONObject().put("operation_id",id).put("status","downloading").put("package",target).put("sha256",hash)
        operationSession = session; pending = null; installSession = -1
        val local = File(context.cacheDir,"codas-$id.apk"); file?.delete(); file = local
        worker.execute {
            try {
                var source = url; var connected: HttpURLConnection? = null
                for (redirect in 0..3) {
                    AgentState.check(session)
                    val c = source.openConnection() as HttpURLConnection
                    connection = c; c.instanceFollowRedirects = false; c.connectTimeout=15000; c.readTimeout=15000
                    val status = c.responseCode
                    if (status in listOf(301,302,303,307,308)) {
                        val location = c.getHeaderField("Location") ?: error("APK_REDIRECT_INVALID")
                        source = https(URL(source,location).toString()); c.disconnect()
                    } else {
                        require(status == 200) { "APK_HTTP_$status" }; connected=c; break
                    }
                }
                val c = connected ?: error("APK_TOO_MANY_REDIRECTS")
                require(c.contentLengthLong <= 512L*1024*1024) { "APK_TOO_LARGE" }
                val digest=MessageDigest.getInstance("SHA-256"); var total=0L
                val deadline=System.currentTimeMillis()+20*60_000
                c.inputStream.use { input -> local.outputStream().use { output ->
                    val buffer=ByteArray(65536)
                    while (true) {
                        AgentState.check(session); check(System.currentTimeMillis()<deadline) { "DOWNLOAD_TIMEOUT" }
                        val count=input.read(buffer); if (count<0) break
                        total+=count; require(total<=512L*1024*1024) { "APK_TOO_LARGE" }
                        digest.update(buffer,0,count);output.write(buffer,0,count)
                    }
                } }
                AgentState.check(session)
                val actual=digest.digest().joinToString("") { "%02x".format(it) }
                require(actual==hash) { "APK_HASH_MISMATCH" }
                val archive=context.packageManager.getPackageArchiveInfo(local.path,android.content.pm.PackageManager.GET_SIGNING_CERTIFICATES) ?: error("INVALID_APK")
                require(archive.packageName==target) { "APK_PACKAGE_MISMATCH" }
                if (selfUpdate) {
                    val installed = context.packageManager.getPackageInfo(context.packageName, android.content.pm.PackageManager.GET_SIGNING_CERTIFICATES)
                    fun signers(info: android.content.pm.PackageInfo): Set<String> = info.signingInfo?.apkContentsSigners?.map {
                        MessageDigest.getInstance("SHA-256").digest(it.toByteArray()).joinToString("") { b -> "%02x".format(b) }
                    }?.toSet() ?: emptySet()
                    Protocol.checkAgentUpdate(installed.longVersionCode, archive.longVersionCode, signers(installed), signers(archive))
                }
                synchronized(this) {
                    AgentState.check(session)
                    state=JSONObject(state.toString()).put("bytes",total).put("version",archive.versionName ?: "")
                    update("ready_to_install")
                }
            } catch(e: Exception) {
                synchronized(this) { if (state.optString("operation_id")==id) update(if (AgentState.enabled) "failed" else "cancelled",safeError(e)) }
                local.delete()
            } finally { connection?.disconnect(); connection=null }
        }
        return JSONObject(state.toString())
    }
    fun install(context: Context) {
        val session: Long
        val apk: File
        val target: String
        synchronized(this) {
            session=operationSession;AgentState.check(session)
            check(state.optString("status")=="ready_to_install") { "APK_NOT_READY" }
            check(context.packageManager.canRequestPackageInstalls()) { "ALLOW_INSTALLATION_ON_PHONE" }
            apk=file ?: error("APK_NOT_READY");target=state.getString("package");update("installing")
        }
        worker.execute {
            try {
                AgentState.check(session)
                val installer=context.packageManager.packageInstaller
                val params=PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL).apply {
                    setAppPackageName(target); setSize(apk.length())
                    if (Build.VERSION.SDK_INT>=31) setRequireUserAction(PackageInstaller.SessionParams.USER_ACTION_REQUIRED)
                }
                val id=installer.createSession(params)
                synchronized(this) { installSession=id }
                installer.openSession(id).use { install ->
                    install.openWrite("base.apk",0,apk.length()).use { out ->
                        apk.inputStream().use { input ->
                            val buffer=ByteArray(65536)
                            while (true) { AgentState.check(session);val n=input.read(buffer);if(n<0)break;out.write(buffer,0,n) }
                        }; install.fsync(out)
                    }
                    AgentState.check(session)
                    val intent=Intent(context,InstallResultReceiver::class.java).setAction("com.codassol.mobile.INSTALL_RESULT")
                    val receiver=PendingIntent.getBroadcast(context,id,intent,PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_MUTABLE)
                    install.commit(receiver.intentSender)
                }
            } catch(e: Exception) { synchronized(this) { update(if(AgentState.enabled) "failed" else "cancelled",safeError(e)) }; abandon(context) }
        }
    }
    @Synchronized fun result(context: Context, intent: Intent) {
        if(intent.action!="com.codassol.mobile.INSTALL_RESULT" || intent.getIntExtra(PackageInstaller.EXTRA_SESSION_ID,-2)!=installSession) return
        when(intent.getIntExtra(PackageInstaller.EXTRA_STATUS,PackageInstaller.STATUS_FAILURE)) {
            PackageInstaller.STATUS_PENDING_USER_ACTION -> {
                if(!AgentState.enabled || AgentState.generation!=operationSession) { cancel(context);return }
                @Suppress("DEPRECATION")
                val next=intent.getParcelableExtra<Intent>(Intent.EXTRA_INTENT)
                if(next==null) { update("failed","MISSING_INSTALL_CONFIRMATION");return }
                pending=next;update("awaiting_confirmation")
            }
            PackageInstaller.STATUS_SUCCESS -> {
                val target=state.optString("package")
                try {
                    val installed=context.packageManager.getPackageInfo(target,0)
                    state=JSONObject(state.toString()).put("installed_version",installed.versionName ?: "").put("status","installed")
                } catch (_: Exception) { update("installation_reported_success_verify_launch") }
                pending=null;file?.delete();installSession=-1
            }
            else -> { update("failed","INSTALL_STATUS_${intent.getIntExtra(PackageInstaller.EXTRA_STATUS,1)}");pending=null;file?.delete();installSession=-1 }
        }
    }
    @Synchronized fun confirmation(): Intent? {
        AgentState.check(operationSession)
        val result=pending;pending=null;return result
    }
    private fun abandon(context: Context) {
        val id=installSession
        if(id>=0) { try { context.packageManager.packageInstaller.abandonSession(id) } catch(_:Exception) {} }
        installSession=-1
    }
    @Synchronized fun cancel(context: Context) {
        connection?.disconnect();pending=null;abandon(context)
        if(state.optString("status") in listOf("downloading","ready_to_install","installing","awaiting_confirmation")) update("cancelled")
        file?.delete()
    }
}
class InstallResultReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) { ApkOperations.result(context,intent) }
}
