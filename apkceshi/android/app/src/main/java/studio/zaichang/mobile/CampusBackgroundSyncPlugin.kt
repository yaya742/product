package studio.zaichang.mobile

import android.content.Context
import android.net.Uri
import androidx.work.Constraints
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.NetworkType
import androidx.work.PeriodicWorkRequest
import androidx.work.WorkManager
import androidx.work.Worker
import androidx.work.WorkerParameters
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import io.ionic.android_js_engine.Context as RunnerContext
import io.ionic.android_js_engine.NativeCapacitorAPI
import io.ionic.android_js_engine.NativeJSFunction
import io.ionic.android_js_engine.Runner
import io.ionic.android_js_engine.capacitor_api.KVAPI
import io.ionic.backgroundrunner.plugin.RunnerConfig
import io.ionic.backgroundrunner.plugin.api.App
import io.ionic.backgroundrunner.plugin.api.Device
import io.ionic.backgroundrunner.plugin.api.Geolocation
import io.ionic.backgroundrunner.plugin.api.Notifications
import io.ionic.backgroundrunner.plugin.conditionalAwait
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.net.URI
import java.util.concurrent.TimeUnit

private const val CAMPUS_SYNC_WORK = "studio.zaichang.mobile.campus-sync"
private const val CAMPUS_SYNC_PREFS = "zaichang_campus_sync"
private const val CAMPUS_HTTP_PREFIX = "zaichang-campus-http:"
private const val SECURE_STUDENT_ID = "zaichang.mobile.campus.student-id"
private const val SECURE_STUDENT_PASSWORD = "zaichang.mobile.campus.password"
private const val MIN_BACKGROUND_INTERVAL_MINUTES = 15L

@CapacitorPlugin(name = "CampusBackgroundSync")
class CampusBackgroundSyncPlugin : Plugin() {
    @PluginMethod
    fun enable(call: PluginCall) {
        try {
            val context = context.applicationContext
            val studentId = SecureStoragePlugin.readStored(context, SECURE_STUDENT_ID)
            val password = SecureStoragePlugin.readStored(context, SECURE_STUDENT_PASSWORD)
            if (studentId.isNullOrBlank() || password.isNullOrBlank()) {
                throw IllegalStateException("campus_credentials_unavailable")
            }

            val year = call.getString("academicYear")?.trim().orEmpty()
            val term = call.getString("term")?.trim().orEmpty()
            if (!year.matches(Regex("20\\d{2}")) || term !in setOf("1", "2")) {
                throw IllegalArgumentException("invalid_academic_term")
            }
            context.getSharedPreferences(CAMPUS_SYNC_PREFS, Context.MODE_PRIVATE).edit()
                .putBoolean("enabled", true)
                .putString("academicYear", year)
                .putString("term", term)
                .commit()

            val constraints = Constraints.Builder()
                .setRequiredNetworkType(NetworkType.CONNECTED)
                .build()
            val request = PeriodicWorkRequest.Builder(
                CampusBackgroundSyncWorker::class.java,
                MIN_BACKGROUND_INTERVAL_MINUTES,
                TimeUnit.MINUTES,
            )
                .setInitialDelay(MIN_BACKGROUND_INTERVAL_MINUTES, TimeUnit.MINUTES)
                .setConstraints(constraints)
                .build()
            WorkManager.getInstance(context).enqueueUniquePeriodicWork(
                CAMPUS_SYNC_WORK,
                ExistingPeriodicWorkPolicy.UPDATE,
                request,
            )
            call.resolve()
        } catch (_: Exception) {
            call.reject("campus_background_sync_enable_failed")
        }
    }

    @PluginMethod
    fun disable(call: PluginCall) {
        try {
            context.applicationContext.getSharedPreferences(CAMPUS_SYNC_PREFS, Context.MODE_PRIVATE)
                .edit().putBoolean("enabled", false).commit()
            WorkManager.getInstance(context).cancelUniqueWork(CAMPUS_SYNC_WORK)
            CampusBackgroundCache.clear(context)
            call.resolve()
        } catch (_: Exception) {
            call.reject("campus_background_sync_disable_failed")
        }
    }

    @PluginMethod
    fun getSnapshot(call: PluginCall) {
        try {
            val context = context.applicationContext
            val state = context.getSharedPreferences(CAMPUS_SYNC_PREFS, Context.MODE_PRIVATE)
            val result = JSObject()
            result.put("snapshot", CampusBackgroundCache.read(context))
            result.put("lastAttemptAt", state.getString("lastAttemptAt", ""))
            result.put("lastStatus", state.getString("lastStatus", "idle"))
            call.resolve(result)
        } catch (_: Exception) {
            call.reject("campus_background_snapshot_unavailable")
        }
    }
}

class CampusBackgroundSyncWorker(context: Context, parameters: WorkerParameters) : Worker(context, parameters) {
    override fun doWork(): Result {
        val context = applicationContext
        val state = context.getSharedPreferences(CAMPUS_SYNC_PREFS, Context.MODE_PRIVATE)
        if (!state.getBoolean("enabled", false)) return Result.success()
        state.edit().putString("lastAttemptAt", System.currentTimeMillis().toString()).commit()

        return try {
            val studentId = SecureStoragePlugin.readStored(context, SECURE_STUDENT_ID)
            val password = SecureStoragePlugin.readStored(context, SECURE_STUDENT_PASSWORD)
            if (studentId.isNullOrBlank() || password.isNullOrBlank()) {
                state.edit().putString("lastStatus", "credentials_unavailable").commit()
                return Result.success()
            }

            val year = state.getString("academicYear", "") ?: ""
            val term = state.getString("term", "") ?: ""
            val args = JSONObject()
                .put("studentId", studentId)
                .put("password", password)
                .put("academicYear", year)
                .put("term", term)
            val result = runBlocking(Dispatchers.IO) { executeRunner(context, args) }
            val domains = result?.optJSONArray("refreshedDomains")
            if (result == null || domains == null || domains.length() == 0) {
                throw IllegalStateException("no_campus_domains_refreshed")
            }
            CampusBackgroundCache.write(context, result.toString())
            state.edit().putString("lastStatus", "ok").commit()
            Result.success()
        } catch (_: Exception) {
            // Never replace a good cache with an auth page, partial error or
            // transport failure. The next periodic run may recover by itself.
            state.edit().putString("lastStatus", "unavailable").commit()
            Result.success()
        }
    }

    private suspend fun executeRunner(context: Context, dataArgs: JSONObject): JSONObject? {
        val configJson = context.assets.open("capacitor.config.json").bufferedReader().use { it.readText() }
        val runnerConfig = RunnerConfig.fromJSON(
            JSONObject(configJson).getJSONObject("plugins").getJSONObject("BackgroundRunner"),
        )
        val source = context.assets.open("public/${runnerConfig.src}").bufferedReader().use { it.readText() }
        val runner = Runner()
        var runnerContext: RunnerContext? = null
        try {
            val api = NativeCapacitorAPI()
            api.initDeviceAPI(Device(context))
            api.initKVAPI(CampusSyncKV(context, runnerConfig.label))
            api.initGeolocationAPI(Geolocation(context))
            api.initNotificationsAPI(Notifications(context))
            api.initAppAPI(App(context))

            runnerContext = runner.createContext(runnerConfig.label, api)
            runnerContext.execute(source, false)

            val future = MutableStateFlow<kotlin.Result<JSONObject?>?>(null)
            val resolve = object : NativeJSFunction(jsFunctionName = "resolve") {
                override fun run() {
                    super.run()
                    future.value = kotlin.Result.success(jsFunctionArgs)
                }
            }
            val reject = object : NativeJSFunction(jsFunctionName = "reject") {
                override fun run() {
                    super.run()
                    future.value = kotlin.Result.failure(IllegalStateException("campus_runner_rejected"))
                }
            }
            runnerContext.registerFunction("_resolveCallback", resolve)
            runnerContext.registerFunction("_rejectCallback", reject)
            val callbacks = JSONObject()
                .put("resolve", "__cbr::_resolveCallback")
                .put("reject", "__cbr::_rejectCallback")
            runnerContext.dispatchEvent(
                runnerConfig.event,
                JSONObject().put("callbacks", callbacks).put("dataArgs", dataArgs),
            )
            runner.waitForJobs()
            val completion = withContext(Dispatchers.IO) { future.conditionalAwait { it != null } }
            return completion?.getOrThrow() ?: throw IllegalStateException("campus_runner_no_result")
        } finally {
            runnerContext?.let { runner.destroyContext(it.name) }
            runner.destroy()
        }
    }
}

/** CapacitorKV remains private to the runner; a reserved key routes safe HTTP. */
private class CampusSyncKV(context: Context, label: String) : KVAPI {
    private val preferences = context.getSharedPreferences(label, Context.MODE_PRIVATE)

    override fun set(key: String, value: String) {
        preferences.edit().putString(key, value).apply()
    }

    override fun get(key: String): String? {
        if (!key.startsWith(CAMPUS_HTTP_PREFIX)) return preferences.getString(key, null)
        return try {
            performTrustedRequest(JSONObject(key.removePrefix(CAMPUS_HTTP_PREFIX))).toString()
        } catch (_: Exception) {
            JSONObject().put("error", "campus_http_failed").toString()
        }
    }

    override fun remove(key: String) {
        preferences.edit().remove(key).apply()
    }

    private fun performTrustedRequest(request: JSONObject): JSObject {
        val rawUrl = request.optString("url", "")
        val uri = URI(rawUrl)
        val host = uri.host?.lowercase() ?: throw IllegalArgumentException("invalid_campus_host")
        if (uri.scheme != "https" || uri.userInfo != null || (uri.port != -1 && uri.port != 443) ||
            !(host == "zju.edu.cn" || host.endsWith(".zju.edu.cn"))) {
            throw IllegalArgumentException("untrusted_campus_url")
        }

        val method = request.optString("method", "GET").uppercase()
        if (method != "GET" && method != "POST") throw IllegalArgumentException("unsupported_campus_method")
        val body = request.optString("body").takeIf { request.has("body") && !request.isNull("body") }
        if (body != null && body.toByteArray(Charsets.UTF_8).size > 256 * 1024) {
            throw IllegalArgumentException("campus_request_too_large")
        }

        val headers = JSObject()
        val requestHeaders = request.optJSONObject("headers") ?: JSONObject()
        val allowedHeaders = setOf(
            "accept", "accept-language", "cache-control", "content-type", "cookie", "pragma",
            "referer", "user-agent", "x-requested-with",
        )
        val iterator = requestHeaders.keys()
        while (iterator.hasNext()) {
            val name = iterator.next()
            val value = requestHeaders.optString(name)
            if (name.lowercase() in allowedHeaders && value.length <= 16 * 1024 &&
                !value.contains('\r') && !value.contains('\n')) {
                headers.put(name, value)
            }
        }
        val referer = requestHeaders.optString("referer", "")
        if (referer.isNotBlank()) {
            val refererUri = URI(referer)
            val refererHost = refererUri.host?.lowercase() ?: throw IllegalArgumentException("invalid_campus_referer")
            if (refererUri.scheme != "https" || !(refererHost == "zju.edu.cn" || refererHost.endsWith(".zju.edu.cn"))) {
                throw IllegalArgumentException("untrusted_campus_referer")
            }
        }

        val responseType = request.optString("responseType", "text").let {
            if (it == "arraybuffer") "arraybuffer" else "text"
        }
        return IsolatedHttp.performBackgroundRequest(rawUrl, method, responseType, body, headers)
    }
}
