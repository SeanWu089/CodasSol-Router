package com.codassol.mobile;

/** A heartbeat belongs to one exact downstream connection, never its successor. */
public final class StreamSession<T> {
    public static final class Handle<T> {
        public final String id;
        public final T connection;
        private long confirmedAt;
        private Handle(String id, T connection, long now) {
            this.id = id; this.connection = connection; confirmedAt = now;
        }
    }
    private Handle<T> current;
    public synchronized void ready(String id, T connection, long now, Runnable publish) {
        current = new Handle<>(id, connection, now); publish.run();
    }
    public synchronized Handle<T> due(long now, long interval) {
        Handle<T> active = current;
        return active != null && now - active.confirmedAt >= interval ? active : null;
    }
    public synchronized void acknowledge(Handle<T> handle, long now) {
        if (current == handle) handle.confirmedAt = now;
    }
    public synchronized T failed(Handle<T> handle, Runnable publish) {
        if (current != handle) return null;
        current = null;
        publish.run();
        return handle.connection;
    }
    public synchronized void clear(T connection) {
        if (current != null && current.connection == connection) current = null;
    }
}
