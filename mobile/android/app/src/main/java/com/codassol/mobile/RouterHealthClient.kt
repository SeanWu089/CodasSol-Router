package com.codassol.mobile

import org.json.JSONException
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL

data class RouterHealth(
    val routerReachable: Boolean,
    val backendReachable: Boolean,
    val detail: String
)

class RouterHealthClient(
    private val healthUrl: String = "http://127.0.0.1:17676/_codassol/health"
) {
    fun check(): RouterHealth {
        var connection: HttpURLConnection? = null
        return try {
            connection = (URL(healthUrl).openConnection() as HttpURLConnection).apply {
                requestMethod = "GET"
                connectTimeout = 1500
                readTimeout = 2000
                useCaches = false
                setRequestProperty("Accept", "application/json")
            }

            val statusCode = connection.responseCode
            if (statusCode !in 200..299) {
                RouterHealth(
                    routerReachable = true,
                    backendReachable = false,
                    detail = "Router replied with HTTP $statusCode"
                )
            } else {
                val body = connection.inputStream.bufferedReader().use { it.readText() }
                val payload = JSONObject(body)
                if (!payload.has("ok") || !payload.has("backendReachable")) {
                    RouterHealth(
                        routerReachable = true,
                        backendReachable = false,
                        detail = "Router returned an incomplete health response."
                    )
                } else if (!payload.optBoolean("ok", false)) {
                    RouterHealth(
                        routerReachable = true,
                        backendReachable = false,
                        detail = "Router response did not report ok=true"
                    )
                } else {
                    val backendReachable = payload.optBoolean("backendReachable", false)
                    RouterHealth(
                        routerReachable = true,
                        backendReachable = backendReachable,
                        detail = if (backendReachable) {
                            "Router and local execution backend are healthy."
                        } else {
                            "Router is reachable, but its local execution backend is unavailable."
                        }
                    )
                }
            }
        } catch (error: JSONException) {
            RouterHealth(
                routerReachable = true,
                backendReachable = false,
                detail = "Router returned invalid health JSON."
            )
        } catch (error: Exception) {
            RouterHealth(
                routerReachable = false,
                backendReachable = false,
                detail = error.message ?: error.javaClass.simpleName
            )
        } finally {
            connection?.disconnect()
        }
    }
}
