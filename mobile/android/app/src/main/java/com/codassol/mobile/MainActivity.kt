package com.codassol.mobile

import android.app.Activity
import android.content.Intent
import android.os.Bundle
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.graphics.Color
import android.net.Uri
import android.text.InputType
import android.widget.*

class MainActivity : Activity() {
    private lateinit var store: PhoneStore
    private lateinit var endpoint: EditText
    private lateinit var pairing: EditText
    private lateinit var access: Switch
    private lateinit var status: TextView
    private lateinit var install: Button
    private val main=Handler(Looper.getMainLooper())
    private var rendering=false
    private val refresh=object:Runnable { override fun run() { render();main.postDelayed(this,1000) } }
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState);store=PhoneStore(this)
        val column=LinearLayout(this).apply { orientation=LinearLayout.VERTICAL;setPadding(32,48,32,32);setBackgroundColor(Color.rgb(246,247,249)) }
        fun label(value:String,size:Float=16f)=TextView(this).apply { text=value;textSize=size;setTextColor(Color.rgb(24,34,48));setPadding(0,12,0,12);column.addView(this) }
        label("Codas · 手机节点",28f)
        label("通过 Wi-Fi 或移动网络接入。关闭访问后停止接收任务。",16f)
        label("Codas 入口")
        endpoint=EditText(this).apply { hint="https://router.example.com";setSingleLine();inputType=InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_URI;setText(store.endpoint);column.addView(this) }
        label("首次配对码（已有配对可留空）")
        pairing=EditText(this).apply { hint="输入配对码";setSingleLine();inputType=InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD;column.addView(this) }
        access=Switch(this).apply { text="允许 Codas 访问手机";textSize=20f;setPadding(0,24,0,24);column.addView(this) }
        status=label("",15f)
        fun button(title:String,action:()->Unit)=Button(this).apply { text=title;setOnClickListener { try { action() } catch(e:Exception) { Toast.makeText(this@MainActivity,safeError(e),Toast.LENGTH_LONG).show() } };column.addView(this) }
        button("允许截图与测试操作") { startActivity(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS)) }
        label("在系统无障碍设置中启用“Codas 测试控制”。截图与点击只在访问开关开启时接受；系统授权和安装确认由你操作。",14f)
        button("允许安装测试应用") { startActivity(Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,Uri.parse("package:$packageName"))) }
        install=button("安装收到的测试包") {
            val state=ApkOperations.snapshot(this)
            if(state.optString("status")=="awaiting_confirmation") {
                val next=ApkOperations.confirmation(); if(next!=null) startActivity(next)
            } else ApkOperations.install(this)
        }
        button("允许后台连接（锁屏使用）") {
            val power = getSystemService(android.os.PowerManager::class.java)
            if (!power.isIgnoringBatteryOptimizations(packageName)) startActivity(Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:$packageName")))
            else Toast.makeText(this, "已允许后台连接", Toast.LENGTH_SHORT).show()
        }
        label("访问开启时保持后台连接，会增加耗电。关闭访问即可停止；系统强行停止后需重新打开应用，手机重启后需手动开启。",14f)
        label("手机标识\n${store.deviceId}",12f)
        setContentView(ScrollView(this).apply { addView(column) })
        access.setOnCheckedChangeListener { _,checked ->
            if(rendering) return@setOnCheckedChangeListener
            if(checked) {
                try {
                    check(AgentService.current==null) { "WAIT_FOR_SERVICE_STOP" }
                    if (endpoint.text.toString().isBlank()) throw IllegalArgumentException("HTTPS_ORIGIN_REQUIRED")
                    try { store.endpoint=endpoint.text.toString() } catch (_: IllegalArgumentException) { throw IllegalArgumentException("HTTPS_ORIGIN_REQUIRED") }
                    val token=pairing.text.toString().trim()
                    check(store.token()!=null || token.isNotEmpty()) { "PAIRING_REQUIRED" }
                    if(Build.VERSION.SDK_INT>=33 && checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS)!=android.content.pm.PackageManager.PERMISSION_GRANTED) requestPermissions(arrayOf(android.Manifest.permission.POST_NOTIFICATIONS),4)
                    startForegroundService(Intent(this,AgentService::class.java).putExtra("pairing",token))
                    pairing.text.clear()
                } catch(e:Exception) { AgentState.status="无法开启：${friendlyError(safeError(e))}";render() }
            } else {
                store.requestAccess(false);AgentState.disable();AgentService.current?.disable();ApkOperations.cancel(this);render()
            }
        }
    }
    override fun onResume() {
        super.onResume()
        if (store.accessRequested() && AgentService.current == null) startForegroundService(Intent(this, AgentService::class.java))
        main.post(refresh)
    }
    override fun onPause() { main.removeCallbacks(refresh);super.onPause() }
    private fun friendlyError(code:String) = when(code) {
        "HTTPS_ORIGIN_REQUIRED" -> "请填写有效的 HTTPS Codas 入口"
        "PAIRING_REQUIRED" -> "请填写首次配对码"
        "WAIT_FOR_SERVICE_STOP" -> "正在关闭连接，请稍后重试"
        "APK_HASH_MISMATCH" -> "安装包校验不一致，请重新发送"
        "ALLOW_INSTALLATION_ON_PHONE" -> "请先允许安装测试应用"
        else -> code
    }
    private fun installStatus(code:String) = when(code) {
        "idle" -> "尚无安装任务"
        "downloading" -> "正在下载安装包"
        "ready_to_install" -> "已下载，请点下方按钮安装"
        "installing" -> "正在准备系统安装"
        "awaiting_confirmation" -> "请点下方按钮继续系统确认"
        "installed" -> "安装完成"
        "cancelled" -> "已取消"
        "failed" -> "安装失败"
        else -> code
    }
    private fun render() {
        if(!::status.isInitialized) return
        rendering=true;access.isChecked=AgentState.enabled;rendering=false
        endpoint.isEnabled=!AgentState.enabled;pairing.isEnabled=!AgentState.enabled
        val op=ApkOperations.snapshot(this)
        val backgroundAllowed = getSystemService(android.os.PowerManager::class.java).isIgnoringBatteryOptimizations(packageName)
        status.text="${AgentState.status}\n后台连接：${if(backgroundAllowed) "已允许" else "请点下方按钮允许锁屏连接"}\n测试控制：${if(PhoneAccessibility.current!=null) "已授权" else "未授权"}\n最近操作：${AgentState.lastAction}\n安装：${installStatus(op.optString("status"))} ${op.optString("package")}\n${friendlyError(op.optString("error"))}"
        install.isEnabled=AgentState.enabled && op.optString("status") in listOf("ready_to_install","awaiting_confirmation")
        install.text=if(op.optString("status")=="awaiting_confirmation") "继续系统安装确认" else "安装收到的测试包"
    }
}
