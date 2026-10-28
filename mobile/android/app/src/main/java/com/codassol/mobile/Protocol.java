package com.codassol.mobile;

import java.io.Reader;
import java.io.IOException;
import java.net.URI;
import java.util.LinkedHashSet;

/** Pure protocol boundary, also exercised on the host JVM without Android. */
public final class Protocol {
    private Protocol() {}
    public static String endpoint(String input) {
        URI u = URI.create(input.trim());
        String path = u.getPath();
        if (!"https".equalsIgnoreCase(u.getScheme()) || u.getHost() == null ||
            u.getUserInfo() != null || u.getQuery() != null || u.getFragment() != null ||
            u.getPort() == 0 || u.getPort() > 65535 ||
            !(path == null || path.isEmpty() || path.equals("/") || path.equals("/mcp"))) {
            throw new IllegalArgumentException("Use an HTTPS origin (or its /mcp URL), without credentials/query.");
        }
        return "https://" + u.getRawAuthority();
    }
    public static void checkJob(boolean enabled, long generation, long expected, long expires, long now) {
        if (!enabled || generation != expected) throw new IllegalStateException("ACCESS_DISABLED");
        if (expires <= now || expires > now + 3_600_000) throw new IllegalStateException("JOB_EXPIRED_OR_INVALID");
    }
    public static void checkCreatedAt(long createdAt, long enabledAt, long expiresAt) {
        if (createdAt < enabledAt || createdAt <= 0 || createdAt >= expiresAt)
            throw new IllegalStateException("JOB_PREDATES_ACCESS_SESSION");
    }
    public static final class SeenJobs {
        private final LinkedHashSet<String> ids = new LinkedHashSet<>();
        public synchronized boolean accept(String id) {
            if (id == null || id.isEmpty() || id.length() > 160 || ids.contains(id)) return false;
            ids.add(id);
            if (ids.size() > 256) ids.remove(ids.iterator().next());
            return true;
        }
    }
    public interface Events { void event(String type, String data) throws Exception; }
    public static void consume(Reader reader, Events events) throws Exception {
        StringBuilder line = new StringBuilder(), data = new StringBuilder();
        String type = "";
        int c;
        while ((c = reader.read()) != -1) {
            if (c != '\n') {
                line.append((char)c);
                if (line.length() > 1_048_576) throw new IOException("SSE_LINE_TOO_LARGE");
                continue;
            }
            String s = line.toString(); line.setLength(0);
            if (s.endsWith("\r")) s = s.substring(0,s.length()-1);
            if (s.isEmpty()) {
                if (data.length() > 0) events.event(type, data.substring(0,data.length()-1));
                type = ""; data.setLength(0);
            } else if (s.startsWith("event:")) type = field(s.substring(6));
            else if (s.startsWith("data:")) {
                data.append(field(s.substring(5))).append('\n');
                if (data.length() > 1_048_576) throw new IOException("SSE_EVENT_TOO_LARGE");
            }
        }
        // Incomplete frames at EOF are never execution requests.
    }
    private static String field(String value) { return value.startsWith(" ") ? value.substring(1) : value; }
}
