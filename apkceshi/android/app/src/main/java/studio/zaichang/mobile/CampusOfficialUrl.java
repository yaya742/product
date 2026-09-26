package studio.zaichang.mobile;

import java.net.URI;
import java.util.Locale;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

final class CampusOfficialUrl {
    private static final Pattern COOKIE_PAIR = Pattern.compile("^[!#$%&'*+.^_`|~0-9A-Za-z-]+=[^\\r\\n]*$");
    private static final Pattern COOKIE_DOMAIN = Pattern.compile("(?i)(?:^|;)\\s*domain\\s*=\\s*([^;\\s]+)");

    private CampusOfficialUrl() {}

    static URI parseTrustedHttps(String value) {
        if (value == null || value.length() > 4096) return null;
        try {
            URI uri = new URI(value);
            String scheme = uri.getScheme();
            String host = uri.getHost();
            if (scheme == null || !"https".equalsIgnoreCase(scheme) || host == null || uri.getRawUserInfo() != null) return null;
            if (uri.getPort() != -1 && uri.getPort() != 443) return null;
            if (!isTrustedHost(host)) return null;
            return uri;
        } catch (Exception ignored) {
            return null;
        }
    }

    static boolean isCoursePage(String value) {
        URI uri = parseTrustedHttps(value);
        return uri != null && "courses.zju.edu.cn".equalsIgnoreCase(uri.getHost());
    }

    static boolean isValidSetCookie(String sourceUrl, String cookie) {
        URI uri = parseTrustedHttps(sourceUrl);
        if (uri == null || cookie == null || cookie.isEmpty() || cookie.length() > 8192 || cookie.indexOf('\r') >= 0 || cookie.indexOf('\n') >= 0) return false;
        int separator = cookie.indexOf('=');
        if (separator <= 0 || !COOKIE_PAIR.matcher(cookie.trim()).matches()) return false;

        Matcher domainMatcher = COOKIE_DOMAIN.matcher(cookie);
        if (!domainMatcher.find()) return true;
        String domain = domainMatcher.group(1).toLowerCase(Locale.ROOT);
        while (domain.startsWith(".")) domain = domain.substring(1);
        String sourceHost = uri.getHost().toLowerCase(Locale.ROOT);
        return isTrustedHost(domain) && (sourceHost.equals(domain) || sourceHost.endsWith("." + domain));
    }

    private static boolean isTrustedHost(String value) {
        String host = value.toLowerCase(Locale.ROOT);
        return "zju.edu.cn".equals(host) || host.endsWith(".zju.edu.cn");
    }
}
