package dev.forgeagent.android;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.graphics.Color;
import android.os.IBinder;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.Collections;
import java.util.HashSet;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;

public final class ConnectionMonitorService extends Service {
    private static final String CONNECTION_CHANNEL_ID = "forgeagent_connection";
    private static final String ACTIVITY_CHANNEL_ID = "forgeagent_activity";
    private static final int CONNECTION_NOTIFICATION_ID = 1001;
    private static final int ACTIVITY_NOTIFICATION_BASE_ID = 2000;
    private static final long POLL_SECONDS = 20;

    private ScheduledExecutorService executor;
    private ExecutorService eventExecutor;
    private ConnectionStore connectionStore;
    private EndpointResolver endpointResolver;
    private volatile boolean connected;
    private volatile String lastMessage = "Checking ForgeAgent...";
    private volatile boolean stopped;
    private final Set<String> mutedSessionIds = Collections.synchronizedSet(new HashSet<>());

    @Override
    public void onCreate() {
        super.onCreate();
        connectionStore = new ConnectionStore(this);
        endpointResolver = new EndpointResolver(connectionStore);
        ensureChannels();
        startForeground(CONNECTION_NOTIFICATION_ID, buildConnectionNotification("Checking ForgeAgent...", false));
        executor = Executors.newSingleThreadScheduledExecutor();
        executor.scheduleWithFixedDelay(this::pollHealth, 0, POLL_SECONDS, TimeUnit.SECONDS);
        eventExecutor = Executors.newSingleThreadExecutor();
        eventExecutor.execute(this::runEventLoop);
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (connectionStore == null || !connectionStore.hasAnyToken()) {
            stopSelf();
            return START_NOT_STICKY;
        }
        updateNotification();
        return START_STICKY;
    }

    @Override
    public void onDestroy() {
        stopped = true;
        if (executor != null) executor.shutdownNow();
        if (eventExecutor != null) eventExecutor.shutdownNow();
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    private void pollHealth() {
        ForgeConnection connection = connectionStore.active();
        if (connection == null || !connection.hasToken()) {
            stopSelf();
            return;
        }
        EndpointResolver.Result result = endpointResolver.resolve(connection);
        connected = result.ok;
        ForgeConnection updated = connectionStore.get(connection.connectionId);
        lastMessage = result.ok
            ? "Connected to " + (updated == null ? connection.name : updated.name)
            : result.message;
        updateNotification();
    }

    private void updateNotification() {
        NotificationManager manager = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager != null) manager.notify(CONNECTION_NOTIFICATION_ID, buildConnectionNotification(lastMessage, connected));
    }

    private Notification buildConnectionNotification(String text, boolean isConnected) {
        Intent openIntent = new Intent(this, MainActivity.class);
        openIntent.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        int flags = PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT;
        PendingIntent pendingIntent = PendingIntent.getActivity(this, 0, openIntent, flags);
        Notification.Builder builder = new Notification.Builder(this, CONNECTION_CHANNEL_ID);
        return builder
            .setSmallIcon(R.drawable.ic_forge_notification)
            .setContentTitle(isConnected ? "ForgeAgent connected" : "ForgeAgent waiting")
            .setContentText(text)
            .setSubText(Instant.now().toString())
            .setContentIntent(pendingIntent)
            .setOngoing(true)
            .setShowWhen(false)
            .setColor(isConnected ? Color.rgb(52, 125, 72) : Color.rgb(191, 116, 25))
            .build();
    }

    private Notification buildActivityNotification(String title, String text, String sessionId, long seq) {
        Intent openIntent = new Intent(this, MainActivity.class);
        openIntent.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        if (sessionId != null && !sessionId.isEmpty()) {
            openIntent.putExtra(MainActivity.EXTRA_SELECT_SESSION_ID, sessionId);
        }
        int flags = PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT;
        PendingIntent pendingIntent = PendingIntent.getActivity(this, (int) (seq % 100_000), openIntent, flags);
        Notification.Builder builder = new Notification.Builder(this, ACTIVITY_CHANNEL_ID);
        return builder
            .setSmallIcon(R.drawable.ic_forge_notification)
            .setContentTitle(title)
            .setContentText(text)
            .setStyle(new Notification.BigTextStyle().bigText(text))
            .setContentIntent(pendingIntent)
            .setAutoCancel(true)
            .setShowWhen(true)
            .setColor(Color.rgb(55, 53, 47))
            .build();
    }

    private void ensureChannels() {
        NotificationManager manager = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager == null) return;
        if (manager.getNotificationChannel(CONNECTION_CHANNEL_ID) == null) {
            NotificationChannel channel = new NotificationChannel(
                CONNECTION_CHANNEL_ID,
                "ForgeAgent connection",
                NotificationManager.IMPORTANCE_LOW
            );
            channel.setDescription("Keeps Android paired with the ForgeAgent desktop service.");
            manager.createNotificationChannel(channel);
        }
        if (manager.getNotificationChannel(ACTIVITY_CHANNEL_ID) == null) {
            NotificationChannel channel = new NotificationChannel(
                ACTIVITY_CHANNEL_ID,
                "ForgeAgent activity",
                NotificationManager.IMPORTANCE_DEFAULT
            );
            channel.setDescription("Replies, approval requests, and blocked sessions from ForgeAgent.");
            manager.createNotificationChannel(channel);
        }
    }

    private void runEventLoop() {
        long backoffMs = 1_000;
        while (!stopped) {
            ForgeConnection connection = connectionStore.active();
            if (connection == null || !connection.hasToken()) {
                stopSelf();
                return;
            }
            try {
                EndpointResolver.Result resolved = endpointResolver.resolve(connection);
                if (!resolved.ok) throw new IllegalStateException(resolved.message);
                ForgeConnection updated = connectionStore.get(connection.connectionId);
                if (updated == null) updated = connection;
                refreshDeviceMuteState(resolved.endpoint, updated.token);
                listenForEvents(resolved.endpoint, updated);
                backoffMs = 1_000;
            } catch (Exception ex) {
                backoffMs = Math.min(30_000, Math.max(1_000, backoffMs * 2));
                sleep(backoffMs);
            }
        }
    }

    private void listenForEvents(String baseUrl, ForgeConnection connectionInfo) throws Exception {
        long cursor = Math.max(connectionInfo.lastEventSeq, connectionInfo.lastNotifiedSeq);
        URL url = new URL(trimTrailingSlash(baseUrl) + "/events?cursor=" + cursor);
        HttpURLConnection connection = (HttpURLConnection) url.openConnection();
        connection.setRequestMethod("GET");
        connection.setConnectTimeout(15_000);
        connection.setReadTimeout(0);
        connection.setRequestProperty("Authorization", "Bearer " + connectionInfo.token);
        int status = connection.getResponseCode();
        if (status < 200 || status >= 300) {
            drain(status >= 400 ? connection.getErrorStream() : connection.getInputStream());
            throw new IllegalStateException("SSE returned HTTP " + status);
        }
        try (BufferedReader reader = new BufferedReader(new InputStreamReader(connection.getInputStream(), StandardCharsets.UTF_8))) {
            String eventType = "";
            StringBuilder data = new StringBuilder();
            String line;
            while (!stopped && (line = reader.readLine()) != null) {
                if (!connectionInfo.connectionId.equals(connectionStore.activeId())) return;
                if (line.isEmpty()) {
                    handleSseEvent(connectionInfo.connectionId, eventType, data.toString());
                    eventType = "";
                    data.setLength(0);
                } else if (line.startsWith("event:")) {
                    eventType = line.substring(6).trim();
                } else if (line.startsWith("data:")) {
                    if (data.length() > 0) data.append('\n');
                    data.append(line.substring(5).trim());
                }
            }
        }
    }

    private void handleSseEvent(String connectionId, String eventType, String data) {
        if (!"session_event".equals(eventType) || data == null || data.isEmpty()) return;
        try {
            JSONObject wrapper = new JSONObject(data);
            String sessionId = wrapper.optString("sessionId", "");
            JSONObject event = wrapper.optJSONObject("event");
            if (event == null) return;
            ForgeConnection connection = connectionStore.get(connectionId);
            if (connection == null) return;
            long seq = event.optLong("seq", 0);
            if (seq > 0) {
                connection.lastEventSeq = Math.max(seq, connection.lastEventSeq);
                connectionStore.upsert(connection);
            }
            if (!shouldNotify(connection, sessionId, event)) return;
            NotificationPayload payload = notificationPayload(sessionId, event);
            if (payload == null) return;
            NotificationManager manager = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
            if (manager != null) {
                manager.notify(ACTIVITY_NOTIFICATION_BASE_ID + (int) (seq % 100_000), buildActivityNotification(payload.title, payload.body, sessionId, seq));
            }
            connection.lastNotifiedSeq = Math.max(seq, connection.lastNotifiedSeq);
            connectionStore.upsert(connection);
        } catch (Exception ignored) {
        }
    }

    private boolean shouldNotify(ForgeConnection connection, String sessionId, JSONObject event) {
        if (!connection.activityNotifications) return false;
        long seq = event.optLong("seq", 0);
        if (seq <= connection.lastNotifiedSeq) return false;
        if (sessionId != null && mutedSessionIds.contains(sessionId)) {
            connection.lastNotifiedSeq = Math.max(seq, connection.lastNotifiedSeq);
            connectionStore.upsert(connection);
            return false;
        }
        String type = event.optString("type", "");
        if ("assistant_message".equals(type) || "permission_request".equals(type) || "mcp_elicitation_request".equals(type)) {
            return true;
        }
        if ("runtime_event".equals(type)) {
            String detail = event.optString("detail", "").toLowerCase();
            String message = event.optString("message", "").toLowerCase();
            return detail.contains("blocked") || message.startsWith("session blocked");
        }
        return false;
    }

    private NotificationPayload notificationPayload(String sessionId, JSONObject event) {
        String type = event.optString("type", "");
        if ("permission_request".equals(type)) {
            return new NotificationPayload("ForgeAgent needs approval", truncate(event.optString("message", "A tool needs approval.")));
        }
        if ("mcp_elicitation_request".equals(type)) {
            return new NotificationPayload("ForgeAgent needs input", truncate(event.optString("message", "A connected MCP server needs input.")));
        }
        if ("assistant_message".equals(type)) {
            return new NotificationPayload("ForgeAgent replied", truncate(stripMarkup(event.optString("text", "Open ForgeAgent to read the reply."))));
        }
        if ("runtime_event".equals(type)) {
            return new NotificationPayload("Session blocked", truncate(event.optString("message", "Open ForgeAgent to review the blocked session.")));
        }
        return null;
    }

    private void refreshDeviceMuteState(String baseUrl, String token) {
        try {
            URL url = new URL(trimTrailingSlash(baseUrl) + "/device-state");
            HttpURLConnection connection = (HttpURLConnection) url.openConnection();
            connection.setRequestMethod("GET");
            connection.setConnectTimeout(8_000);
            connection.setReadTimeout(8_000);
            connection.setRequestProperty("Authorization", "Bearer " + token);
            int status = connection.getResponseCode();
            InputStream stream = status >= 200 && status < 300 ? connection.getInputStream() : connection.getErrorStream();
            if (status < 200 || status >= 300) {
                drain(stream);
                return;
            }
            String text = readAll(stream);
            JSONObject state = new JSONObject(text);
            JSONArray muted = state.optJSONArray("mutedSessionIds");
            Set<String> next = new HashSet<>();
            if (muted != null) {
                for (int i = 0; i < muted.length(); i++) {
                    String value = muted.optString(i, "");
                    if (!value.isEmpty()) next.add(value);
                }
            }
            synchronized (mutedSessionIds) {
                mutedSessionIds.clear();
                mutedSessionIds.addAll(next);
            }
        } catch (Exception ignored) {
        }
    }

    private String readAll(InputStream stream) throws Exception {
        if (stream == null) return "";
        StringBuilder builder = new StringBuilder();
        try (BufferedReader reader = new BufferedReader(new InputStreamReader(stream, StandardCharsets.UTF_8))) {
            String line;
            while ((line = reader.readLine()) != null) builder.append(line);
        }
        return builder.toString();
    }

    private void drain(InputStream stream) throws Exception {
        if (stream != null) while (stream.read() != -1) {
            // Drain response body before reconnecting.
        }
    }

    private void sleep(long millis) {
        try {
            Thread.sleep(millis);
        } catch (InterruptedException ignored) {
            Thread.currentThread().interrupt();
        }
    }

    private String stripMarkup(String value) {
        return value
            .replaceAll("```[\\s\\S]*?```", " code block ")
            .replaceAll("<[^>]+>", " ")
            .replaceAll("[#*_`~>\\[\\]()]","")
            .replaceAll("\\s+", " ")
            .trim();
    }

    private String truncate(String value) {
        String clean = value == null ? "" : value.replaceAll("\\s+", " ").trim();
        if (clean.length() <= 180) return clean;
        return clean.substring(0, 179) + "…";
    }

    private String trimTrailingSlash(String value) {
        while (value.endsWith("/")) value = value.substring(0, value.length() - 1);
        return value;
    }

    private String hostLabel(String value) {
        try {
            return new URL(value).getHost();
        } catch (Exception ignored) {
            return value == null || value.isEmpty() ? "ForgeAgent" : value;
        }
    }

    private static final class NotificationPayload {
        final String title;
        final String body;

        NotificationPayload(String title, String body) {
            this.title = title;
            this.body = body;
        }
    }
}
