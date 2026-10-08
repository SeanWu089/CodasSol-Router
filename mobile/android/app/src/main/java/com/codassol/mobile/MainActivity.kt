package com.codassol.mobile

import android.app.Activity
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.widget.Button
import android.widget.TextView
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.concurrent.Executors

class MainActivity : Activity() {
    private val executor = Executors.newSingleThreadExecutor()
    private val mainHandler = Handler(Looper.getMainLooper())
    private val healthClient = RouterHealthClient()

    private lateinit var routerStatus: TextView
    private lateinit var backendStatus: TextView
    private lateinit var detailText: TextView
    private lateinit var checkButton: Button

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        routerStatus = findViewById(R.id.routerStatus)
        backendStatus = findViewById(R.id.backendStatus)
        detailText = findViewById(R.id.detailText)
        checkButton = findViewById(R.id.checkButton)

        checkButton.setOnClickListener { checkConnection() }
        checkConnection()
    }

    override fun onDestroy() {
        executor.shutdownNow()
        super.onDestroy()
    }

    private fun checkConnection() {
        setCheckingState()
        executor.execute {
            val health = healthClient.check()
            mainHandler.post {
                if (isFinishing || isDestroyed) return@post
                renderResult(health)
            }
        }
    }

    private fun setCheckingState() {
        checkButton.isEnabled = false
        routerStatus.setText(R.string.checking)
        backendStatus.setText(R.string.checking)
        routerStatus.setTextColor(getColor(R.color.pending))
        backendStatus.setTextColor(getColor(R.color.pending))
        detailText.setText(R.string.checking)
    }

    private fun renderResult(health: RouterHealth) {
        checkButton.isEnabled = true

        if (health.routerReachable) {
            routerStatus.setText(R.string.connected)
            routerStatus.setTextColor(getColor(R.color.success))
        } else {
            routerStatus.setText(R.string.disconnected)
            routerStatus.setTextColor(getColor(R.color.danger))
        }

        if (health.backendReachable) {
            backendStatus.setText(R.string.reachable)
            backendStatus.setTextColor(getColor(R.color.success))
        } else {
            backendStatus.setText(R.string.unreachable)
            backendStatus.setTextColor(getColor(R.color.danger))
        }

        val timestamp = SimpleDateFormat("HH:mm:ss", Locale.getDefault()).format(Date())
        detailText.text = health.detail + "\nLast check · " + timestamp
    }
}
