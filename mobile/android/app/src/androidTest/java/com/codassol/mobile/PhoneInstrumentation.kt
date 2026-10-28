package com.codassol.mobile
import android.app.Instrumentation
import android.app.Activity
import android.os.Bundle
import android.util.Base64
import org.json.JSONObject

/** Runs only before pairing/access activation on a development test phone. */
class PhoneInstrumentation : Instrumentation() {
    private var setup = false
    override fun onCreate(arguments: Bundle?) { setup = arguments?.getString("setup") == "true"; super.onCreate(arguments); start() }
    override fun onStart() {
        val report=Bundle();var checks=0
        if (setup) {
            val input = java.io.File(targetContext.filesDir,"onboarding-test.json")
            var sensitive = ""
            try {
                check(!AgentState.enabled)
                val data = JSONObject(input.readText()); sensitive=data.getString("pairing"); input.delete()
                val store = PhoneStore(targetContext); store.endpoint = data.getString("endpoint")
                val c = java.net.URL(store.endpoint+"/_codassol/agent/enroll").openConnection() as java.net.HttpURLConnection
                try {
                    c.instanceFollowRedirects=false;c.connectTimeout=15000;c.readTimeout=15000;c.requestMethod="POST";c.doOutput=true
                    c.setRequestProperty("Authorization","Bearer "+data.getString("pairing"));c.setRequestProperty("Content-Type","application/json")
                    c.outputStream.use { it.write(store.metadata().toString().toByteArray()) }
                    check(c.responseCode==201) { "ENROLL_HTTP_${c.responseCode}" }
                    val result = JSONObject(c.inputStream.bufferedReader().readText())
                    check(result.getString("deviceId")==store.deviceId)
                    store.saveToken(result.getString("agentToken"))
                    report.putString("stream","Phone HTTPS enrollment and encrypted credential storage passed.\n")
                    finish(Activity.RESULT_OK,report)
                } finally { c.disconnect() }
            } catch(e:Exception) { report.putString("stream","Provisioning failed: ${e.javaClass.name}: ${if(sensitive.isNotEmpty()) e.message?.replace(sensitive, "[redacted]") else safeError(e)}\n${e.stackTrace.take(4).joinToString("\n")}\n");finish(1,report) }
            finally { input.delete() }
            return
        }
        try {
            check(!AgentState.enabled) { "Stop phone access before instrumentation" }
            val store=PhoneStore(targetContext)
            val generation=AgentState.enable()
            val commands=PhoneCommands(targetContext,store,generation,System.currentTimeMillis()+30000)
            fun call(name:String,args:JSONObject):JSONObject {
                val message=JSONObject().put("jsonrpc","2.0").put("id",1).put("method","tools/call")
                    .put("params",JSONObject().put("name",name).put("arguments",args))
                val payload=JSONObject().put("type","devspace-http").put("request",JSONObject()
                    .put("path","/mcp").put("method","POST").put("bodyBase64",Base64.encodeToString(message.toString().toByteArray(),Base64.NO_WRAP)))
                val result=commands.execute(payload)
                return JSONObject(String(Base64.decode(result.getString("bodyBase64"),Base64.DEFAULT))).getJSONObject("result")
            }
            val opened=call("open_workspace",JSONObject().put("path","/codas/android"))
            check(opened.getJSONObject("structuredContent").getString("workspace_id")==store.workspaceId);checks++
            check(call("open_workspace",JSONObject().put("path","/sdcard")).getBoolean("isError"));checks++
            val info=call("exec_command",JSONObject().put("workspace_id",store.workspaceId).put("cmd","android info"))
            check(JSONObject(info.getJSONObject("structuredContent").getString("result")).getString("device_id")==store.deviceId);checks++
            check(call("exec_command",JSONObject().put("workspace_id","wrong").put("cmd","android info")).getBoolean("isError"));checks++
            check(call("exec_command",JSONObject().put("workspace_id",store.workspaceId).put("cmd","rm -rf /sdcard")).getBoolean("isError"));checks++
            AgentState.disable()
            var denied=false;try { call("open_workspace",JSONObject().put("path","/codas/android")) } catch(_:Exception) { denied=true }
            check(denied);checks++
            report.putString("stream","Native phone protocol checks passed: $checks\n")
            finish(Activity.RESULT_OK,report)
        } catch(e:Throwable) { report.putString("stream","FAILED after $checks: ${e.javaClass.simpleName}\n");finish(1,report) }
        finally { AgentState.disable() }
    }
}
