package studio.zaichang.mobile;

import android.app.DownloadManager;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Environment;
import android.webkit.CookieManager;
import android.webkit.WebSettings;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.util.ArrayList;
import java.util.List;

@CapacitorPlugin(name = "CampusOfficialPage")
public class CampusOfficialPagePlugin extends Plugin {
    @PluginMethod
    public void open(PluginCall call) {
        String url = call.getString("url", "");
        if (!CampusOfficialUrl.isCoursePage(url)) {
            call.reject("official_course_url_required");
            return;
        }

        try {
            Intent intent = new Intent(getActivity(), CampusOfficialPageActivity.class);
            intent.putExtra(CampusOfficialPageActivity.EXTRA_URL, url);
            getActivity().startActivity(intent);
            call.resolve();
        } catch (Exception ignored) {
            call.reject("official_page_open_failed");
        }
    }

    @PluginMethod
    public void downloadAttachment(PluginCall call) {
        String url = call.getString("url", "");
        if (!CampusOfficialUrl.isCoursePage(url)) {
            call.reject("official_course_attachment_url_required");
            return;
        }

        try {
            DownloadManager manager = (DownloadManager) getContext().getSystemService(Context.DOWNLOAD_SERVICE);
            if (manager == null) {
                call.reject("android_download_manager_unavailable");
                return;
            }

            String requestedName = call.getString("fileName", "assignment-attachment");
            String fileName = CampusOfficialUrl.safeAttachmentFileName(requestedName, System.currentTimeMillis());
            DownloadManager.Request request = new DownloadManager.Request(Uri.parse(url));
            request.setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, fileName);
            request.setTitle(requestedName);
            request.setDescription("学在浙大作业附件");
            request.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);

            String cookieHeader = CookieManager.getInstance().getCookie(url);
            if (cookieHeader != null && !cookieHeader.isEmpty()) request.addRequestHeader("Cookie", cookieHeader);
            request.addRequestHeader("Referer", "https://courses.zju.edu.cn/");
            request.addRequestHeader("User-Agent", WebSettings.getDefaultUserAgent(getContext()));
            manager.enqueue(request);
            call.resolve();
        } catch (Exception ignored) {
            call.reject("assignment_attachment_download_failed");
        }
    }

    @PluginMethod
    public void setCookies(PluginCall call) {
        String url = call.getString("url", "");
        JSArray values = call.getArray("cookies");
        if (CampusOfficialUrl.parseTrustedHttps(url) == null) {
            call.reject("trusted_campus_cookie_target_required");
            return;
        }
        if (values == null || values.length() > 64) {
            call.reject("invalid_campus_cookie_batch");
            return;
        }

        List<String> cookies = new ArrayList<>();
        try {
            for (int index = 0; index < values.length(); index++) {
                String value = values.getString(index);
                if (!CampusOfficialUrl.isValidSetCookie(url, value)) {
                    call.reject("invalid_campus_cookie_header");
                    return;
                }
                cookies.add(value);
            }
        } catch (Exception ignored) {
            call.reject("invalid_campus_cookie_batch");
            return;
        }

        CookieManager manager = CookieManager.getInstance();
        manager.setAcceptCookie(true);
        setCookieAt(manager, url, cookies, 0, call);
    }

    private void setCookieAt(CookieManager manager, String url, List<String> cookies, int index, PluginCall call) {
        if (index >= cookies.size()) {
            manager.flush();
            call.resolve(new JSObject());
            return;
        }
        manager.setCookie(url, cookies.get(index), accepted -> {
            if (!accepted) {
                call.reject("campus_cookie_sync_failed");
                return;
            }
            setCookieAt(manager, url, cookies, index + 1, call);
        });
    }
}
