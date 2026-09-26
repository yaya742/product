package studio.zaichang.mobile;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public class CampusOfficialUrlTest {
    @Test
    public void allowsOfficialCoursePageAndCampusSsoHosts() {
        assertTrue(CampusOfficialUrl.isCoursePage("https://courses.zju.edu.cn/course/102844/learning-activity#/1191531"));
        assertTrue(CampusOfficialUrl.parseTrustedHttps("https://identity.zju.edu.cn/cas/login") != null);
        assertTrue(CampusOfficialUrl.parseTrustedHttps("https://webvpn.zju.edu.cn/login") != null);
    }

    @Test
    public void rejectsUntrustedOrInsecureNavigation() {
        assertFalse(CampusOfficialUrl.isCoursePage("http://courses.zju.edu.cn/course/1/learning-activity#/2"));
        assertFalse(CampusOfficialUrl.isCoursePage("https://courses.zju.edu.cn.evil.example/course/1"));
        assertFalse(CampusOfficialUrl.isCoursePage("https://user@courses.zju.edu.cn/course/1"));
        assertFalse(CampusOfficialUrl.isCoursePage("https://courses.zju.edu.cn:8443/course/1"));
        assertFalse(CampusOfficialUrl.parseTrustedHttps("https://evil.example/") != null);
    }

    @Test
    public void sanitizesAttachmentNamesAndAddsAUniqueSuffix() {
        assertEquals("lab__report__12345.docx", CampusOfficialUrl.safeAttachmentFileName("lab/\\report?.docx", 12345));
        assertEquals("assignment-attachment_7", CampusOfficialUrl.safeAttachmentFileName("../", 7));
        StringBuilder longName = new StringBuilder();
        for (int index = 0; index < 300; index++) longName.append('x');
        assertTrue(CampusOfficialUrl.safeAttachmentFileName(longName + ".pdf", 1).length() <= 180);
    }

    @Test
    public void acceptsOnlyCookieHeadersBoundToTrustedCampusHosts() {
        assertTrue(CampusOfficialUrl.isValidSetCookie(
            "https://courses.zju.edu.cn/api/todos",
            "session=secret; Path=/; Secure; HttpOnly; SameSite=Lax"
        ));
        assertTrue(CampusOfficialUrl.isValidSetCookie(
            "https://courses.zju.edu.cn/api/todos",
            "sso=secret; Domain=.zju.edu.cn; Path=/; Secure; HttpOnly"
        ));
        assertFalse(CampusOfficialUrl.isValidSetCookie(
            "https://courses.zju.edu.cn/api/todos",
            "session=secret; Domain=.evil.example; Path=/; Secure"
        ));
        assertFalse(CampusOfficialUrl.isValidSetCookie(
            "https://courses.zju.edu.cn/api/todos",
            "session=secret\r\nSet-Cookie: injected=yes"
        ));
    }
}
