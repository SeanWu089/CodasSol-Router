package com.codassol.mobile;

import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

public final class StreamSessionTest {
    static void check(boolean value, String message) { if (!value) throw new AssertionError(message); }
    public static void main(String[] args) throws Exception {
        var streams = new StreamSession<Object>();
        Object oldConnection = new Object(), freshConnection = new Object();
        var status = new AtomicReference<>("initial");
        streams.ready("old", oldConnection, 0, () -> status.set("old ready"));
        var old = streams.due(20, 20);
        streams.ready("fresh", freshConnection, 100, () -> status.set("fresh ready"));
        check(streams.failed(old, () -> status.set("old heartbeat failed")) == null, "Stale failure must not close a stream");
        check(status.get().equals("fresh ready"), "Stale heartbeat overwrote successor status");
        streams.acknowledge(old, 1000);
        check(streams.due(120, 20).connection == freshConnection, "Stale ACK changed successor heartbeat time");
        streams.clear(oldConnection);
        check(streams.due(120, 20).connection == freshConnection, "Old cleanup cleared successor");

        var active = streams.due(120, 20);
        Object closing = streams.failed(active, () -> status.set("active failed"));
        streams.ready("next", new Object(), 200, () -> status.set("next ready"));
        check(closing == freshConnection, "Failure must capture its own connection, not close a later snapshot");
        streams.acknowledge(active, 1000);
        check(streams.due(220, 20) != null, "Late success changed replacement timing");

        // Hold failure publication while another thread attempts to publish ready.
        // Their observable state writes must serialize under the same monitor.
        var failing = streams.due(220, 20);
        var failureEntered = new CountDownLatch(1);
        var attemptedReady = new CountDownLatch(1);
        var readyPublished = new CountDownLatch(1);
        var error = new AtomicReference<Throwable>();
        Thread ready = new Thread(() -> {
            try {
                check(failureEntered.await(2, TimeUnit.SECONDS), "Failure did not start");
                attemptedReady.countDown();
                streams.ready("last", new Object(), 300, () -> { status.set("last ready"); readyPublished.countDown(); });
            } catch (Throwable e) { error.set(e); }
        });
        ready.start();
        streams.failed(failing, () -> {
            try {
                failureEntered.countDown();
                check(attemptedReady.await(2, TimeUnit.SECONDS), "Ready did not start");
                check(!readyPublished.await(100, TimeUnit.MILLISECONDS), "Ready raced inside failure publication");
                status.set("failure published");
            } catch (InterruptedException e) { throw new AssertionError(e); }
        });
        ready.join(2000);
        check(!ready.isAlive(), "Ready deadlocked");
        if (error.get() != null) throw new AssertionError(error.get());
        check(status.get().equals("last ready"), "Old failure publication won after successor ready");
        System.out.println("Stream callback isolation checks passed");
    }
}
