package studio.zaichang.mobile;

import android.util.Base64;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.CookieHandler;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.io.IOException;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * HTTP transport for campus services that must not share Capacitor's global
 * CookieHandler. Cookies are supplied and collected by the JavaScript caller.
 */
@CapacitorPlugin(name = "IsolatedHttp")
public class IsolatedHttp extends Plugin {
    private static final Object COOKIE_HANDLER_LOCK = new Object();
    private static final ExecutorService EXECUTOR = Executors.newCachedThreadPool();
    private static final int MAX_BACKGROUND_RESPONSE_BYTES = 4 * 1024 * 1024;

    @PluginMethod
    public void request(PluginCall call) {
        final String url = call.getString("url", "");
        final String method = call.getString("method", "GET");
        final String responseType = call.getString("responseType", "text");
        final boolean disableRedirects = call.getBoolean("disableRedirects", true);
        final String body = call.getString("body", null);
        final JSObject headers = call.getObject("headers");

        if (url.isEmpty()) {
            call.reject("IsolatedHttp requires a URL");
            return;
        }

        EXECUTOR.execute(() -> {
            try {
                call.resolve(performRequest(url, method, responseType, disableRedirects, body, headers));
            } catch (Exception error) {
                call.reject(error.getMessage() == null ? "Isolated HTTP request failed" : error.getMessage(), error);
            }
        });
    }

    private JSObject performRequest(
        String url,
        String method,
        String responseType,
        boolean disableRedirects,
        String body,
        JSObject headers
    ) throws Exception {
        return performRequestInternal(url, method, responseType, disableRedirects, body, headers, 0);
    }

    static JSObject performBackgroundRequest(
        String url,
        String method,
        String responseType,
        String body,
        JSObject headers
    ) throws Exception {
        return performRequestInternal(url, method, responseType, true, body, headers, MAX_BACKGROUND_RESPONSE_BYTES);
    }

    private static JSObject performRequestInternal(
        String url,
        String method,
        String responseType,
        boolean disableRedirects,
        String body,
        JSObject headers,
        int maxResponseBytes
    ) throws Exception {
        // CapacitorCookies installs a process-wide CookieHandler. Temporarily
        // disable it while this connection is active so no gateway or other
        // campus module cookie can be appended to the explicit Cookie header.
        synchronized (COOKIE_HANDLER_LOCK) {
            CookieHandler previousHandler = CookieHandler.getDefault();
            CookieHandler.setDefault(null);
            HttpURLConnection connection = null;
            try {
                connection = (HttpURLConnection) new URL(url).openConnection();
                connection.setInstanceFollowRedirects(!disableRedirects);
                connection.setConnectTimeout(20_000);
                connection.setReadTimeout(30_000);
                connection.setRequestMethod(method);
                connection.setRequestProperty("Accept-Encoding", "identity");

                if (headers != null) {
                    java.util.Iterator<String> keys = headers.keys();
                    while (keys.hasNext()) {
                        String key = keys.next();
                        Object value = headers.opt(key);
                        if (value != null && value != org.json.JSONObject.NULL) {
                            connection.setRequestProperty(key, String.valueOf(value));
                        }
                    }
                }

                if (body != null && !body.isEmpty() && !"GET".equalsIgnoreCase(method) && !"HEAD".equalsIgnoreCase(method)) {
                    byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
                    connection.setDoOutput(true);
                    connection.setFixedLengthStreamingMode(bytes.length);
                    try (OutputStream output = connection.getOutputStream()) {
                        output.write(bytes);
                    }
                }

                int status = connection.getResponseCode();
                InputStream input = status >= 400 ? connection.getErrorStream() : connection.getInputStream();
                byte[] bytes = input == null ? new byte[0] : readAll(input, maxResponseBytes);
                JSObject result = new JSObject();
                result.put("status", status);
                result.put("url", connection.getURL().toString());
                result.put("data", "arraybuffer".equals(responseType)
                    ? Base64.encodeToString(bytes, Base64.NO_WRAP)
                    : new String(bytes, StandardCharsets.UTF_8));

                JSObject responseHeaders = new JSObject();
                Map<String, List<String>> headerFields = connection.getHeaderFields();
                if (headerFields != null) {
                    for (Map.Entry<String, List<String>> entry : headerFields.entrySet()) {
                        if (entry.getKey() == null || entry.getValue() == null) continue;
                        responseHeaders.put(entry.getKey(), String.join("\n", entry.getValue()));
                    }
                }
                result.put("headers", responseHeaders);
                return result;
            } finally {
                if (connection != null) connection.disconnect();
                CookieHandler.setDefault(previousHandler);
            }
        }
    }

    private static byte[] readAll(InputStream input, int maxBytes) throws Exception {
        try (InputStream source = input; ByteArrayOutputStream output = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[8192];
            int count;
            while ((count = source.read(buffer)) != -1) {
                if (maxBytes > 0 && output.size() + count > maxBytes) throw new IOException("campus_response_too_large");
                output.write(buffer, 0, count);
            }
            return output.toByteArray();
        }
    }
}
