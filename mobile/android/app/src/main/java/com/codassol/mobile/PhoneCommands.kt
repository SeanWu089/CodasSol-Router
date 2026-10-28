package com.codassol.mobile

import android.content.Context
import android.app.KeyguardManager
import android.os.Build
import android.util.Base64
import org.json.JSONArray
import org.json.JSONObject

class PhoneCommands(private val context: Context, private val store: PhoneStore, private val session: Long, private val expires: Long) {
    private fun check() = AgentState.check(session, expires)
    fun execute(payload: JSONObject): JSONObject {
        check()
        require(payload.getString("type") == "devspace-http") { "UNSUPPORTED_JOB_TYPE" }
        val request = payload.getJSONObject("request")
        require(request.optString("path", "/mcp") == "/mcp" && request.optString("method", "POST") == "POST") { "UNSUPPORTED_REQUEST" }
        val body = String(Base64.decode(request.getString("bodyBase64"), Base64.DEFAULT), Charsets.UTF_8)
        require(body.length <= 262144) { "REQUEST_TOO_LARGE" }
        // One operation per request keeps expiry, cancellation and identity unambiguous.
        val message = JSONObject(body)
        val reply = JSONObject().put("jsonrpc", "2.0").put("id", message.opt("id") ?: JSONObject.NULL)
        try { reply.put("result", call(message)) }
        catch (e: Exception) {
            reply.put("result", JSONObject().put("isError", true).put("content", JSONArray().put(text(safeError(e)))))
        }
        return JSONObject().put("statusCode", 200).put("headers", JSONObject().put("content-type", "application/json"))
            .put("bodyBase64", Base64.encodeToString(reply.toString().toByteArray(), Base64.NO_WRAP))
    }
    private fun call(message: JSONObject): JSONObject {
        check()
        require(message.getString("method") == "tools/call") { "UNSUPPORTED_METHOD" }
        val params = message.getJSONObject("params")
        val args = params.getJSONObject("arguments")
        if (params.getString("name") == "open_workspace") {
            require(args.getString("path").trimEnd('/') == "/codas/android") { "INVALID_PHONE_WORKSPACE" }
            require(args.optString("mode", "checkout") == "checkout") { "WORKTREE_UNSUPPORTED_ON_PHONE" }
            val instructions = "Android phone workspace. No shell or general filesystem. Use exec_command with this workspace_id and cmd='android info' or 'android '+JSON. Actions: info; apps; screenshot; tap {x,y}; swipe {x,y,endX,endY,durationMs}; launch {package}; install {url,sha256,package}; update_agent {url,sha256}; install_status. Coordinates use physical display pixels returned by screenshot. Installation returns an operation id: poll install_status; user opens Codas and confirms installation on the phone. Never automate system permission, installation or security confirmations. Read/open/apply_patch/shell/process tools are unsupported. Access must remain enabled; phone must be unlocked for visual operations. Download supports one single APK up to 512 MiB; compilation runs elsewhere. A launch request is not proof the app opened: verify with screenshot/info. Installed package verification appears in install_status."
            val data = JSONObject().put("workspace_id", store.workspaceId).put("root", "/codas/android").put("mode", "checkout")
                .put("instruction", instructions).put("review", JSONObject().put("available", false).put("reason", "Native phone operations"))
            return JSONObject().put("structuredContent", data).put("content", JSONArray().put(text(data.toString())))
        }
        require(params.getString("name") == "exec_command") { "UNSUPPORTED_PHONE_TOOL" }
        require(args.getString("workspace_id") == store.workspaceId) { "WRONG_PHONE_WORKSPACE" }
        val cmd = args.getString("cmd").trim()
        require(cmd.startsWith("android ") && cmd.length < 8192) { "USE_ANDROID_COMMANDS_NO_SHELL" }
        val input = cmd.substring(8).trim()
        val operation = if (input.startsWith("{")) JSONObject(input) else JSONObject().put("action", input)
        val action = operation.getString("action")
        check()
        val data: JSONObject
        val content = JSONArray()
        when (action) {
            "info" -> data = JSONObject().put("device_id", store.deviceId).put("manufacturer", Build.MANUFACTURER)
                .put("model", Build.MODEL).put("android", Build.VERSION.RELEASE).put("sdk", Build.VERSION.SDK_INT)
                .put("agent_version", context.packageManager.getPackageInfo(context.packageName,0).versionName)
                .put("agent_version_code", context.packageManager.getPackageInfo(context.packageName,0).longVersionCode)
                .put("access_enabled", AgentState.enabled).put("control_ready", PhoneAccessibility.current != null)
                .put("locked", context.getSystemService(KeyguardManager::class.java).isKeyguardLocked)
                .put("foreground_package", PhoneAccessibility.current?.rootInActiveWindow?.packageName?.toString() ?: JSONObject.NULL)
            "apps" -> {
                val intent = android.content.Intent(android.content.Intent.ACTION_MAIN).addCategory(android.content.Intent.CATEGORY_LAUNCHER)
                val apps = JSONArray()
                context.packageManager.queryIntentActivities(intent, 0).distinctBy { it.activityInfo.packageName }.take(300).forEach {
                    apps.put(JSONObject().put("package", it.activityInfo.packageName).put("label", it.loadLabel(context.packageManager).toString()))
                }
                data = JSONObject().put("apps", apps)
            }
            "update_agent" -> data = ApkOperations.download(context, JSONObject(operation.toString()).put("package",context.packageName), session, selfUpdate = true)
            "install" -> data = ApkOperations.download(context, operation, session)
            "install_status" -> data = ApkOperations.snapshot(context)
            "launch" -> {
                val target = operation.getString("package"); require(target.matches(Regex("[a-zA-Z][a-zA-Z0-9_]*(\\.[a-zA-Z0-9_]+)+"))) { "INVALID_PACKAGE" }
                val control = control()
                control.launch(target, session, expires)
                data = JSONObject().put("status", "launch_requested").put("package", target)
            }
            "screenshot" -> {
                val shot = control().capture(session, expires)
                data = shot.first
                content.put(JSONObject().put("type", "image").put("mimeType", "image/jpeg").put("data", shot.second))
            }
            "tap", "swipe" -> {
                control().gesture(operation, session, expires)
                data = JSONObject().put("status", "gesture_completed")
            }
            else -> throw IllegalArgumentException("UNSUPPORTED_ANDROID_ACTION")
        }
        check()
        AgentState.lastAction = action
        content.put(text(data.toString()))
        return JSONObject().put("content", content).put("structuredContent", JSONObject()
            .put("result", data.toString()).put("exit_code", 0).put("running", false).put("output_truncated", false).put("wall_time_ms", 0))
    }
    private fun control(): PhoneAccessibility {
        check()
        require(!context.getSystemService(KeyguardManager::class.java).isKeyguardLocked) { "UNLOCK_PHONE_REQUIRED" }
        return PhoneAccessibility.current ?: throw IllegalStateException("ENABLE_ACCESSIBILITY_ON_PHONE")
    }
    private fun text(value: String) = JSONObject().put("type", "text").put("text", value)
}
