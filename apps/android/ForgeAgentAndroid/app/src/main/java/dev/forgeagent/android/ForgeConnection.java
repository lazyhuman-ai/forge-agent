package dev.forgeagent.android;

import org.json.JSONArray;
import org.json.JSONObject;

import java.net.URL;
import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.Set;
import java.util.UUID;

public final class ForgeConnection {
    public String connectionId;
    public String coreId;
    public String name;
    public String token;
    public final ArrayList<String> knownEndpoints = new ArrayList<>();
    public String lastWorkingEndpoint;
    public String lastSeenAt;
    public String status;
    public String statusMessage;
    public long lastEventSeq;
    public long lastNotifiedSeq;
    public boolean activityNotifications = true;

    public static ForgeConnection create(String coreId, String name, String token) {
        ForgeConnection connection = new ForgeConnection();
        connection.connectionId = UUID.randomUUID().toString();
        connection.coreId = safe(coreId);
        connection.name = safe(name).isEmpty() ? "ForgeAgent Desktop" : safe(name);
        connection.token = safe(token);
        connection.status = "unknown";
        connection.statusMessage = "Not checked yet.";
        return connection;
    }

    public static ForgeConnection legacy(String baseUrl, String token, long lastEventSeq, long lastNotifiedSeq, boolean notifications) {
        ForgeConnection connection = create("", hostLabel(baseUrl), token);
        connection.addEndpoint(baseUrl);
        connection.lastWorkingEndpoint = trimTrailingSlash(baseUrl);
        connection.lastEventSeq = Math.max(0, lastEventSeq);
        connection.lastNotifiedSeq = Math.max(0, lastNotifiedSeq);
        connection.activityNotifications = notifications;
        connection.statusMessage = "Imported from the previous Android connection.";
        return connection;
    }

    public static ForgeConnection fromJson(JSONObject json) {
        ForgeConnection connection = new ForgeConnection();
        connection.connectionId = json.optString("connectionId", UUID.randomUUID().toString());
        connection.coreId = json.optString("coreId", "");
        connection.name = json.optString("name", "ForgeAgent Desktop");
        connection.token = json.optString("token", "");
        connection.lastWorkingEndpoint = json.optString("lastWorkingEndpoint", "");
        connection.lastSeenAt = json.optString("lastSeenAt", "");
        connection.status = json.optString("status", "unknown");
        connection.statusMessage = json.optString("statusMessage", "Not checked yet.");
        connection.lastEventSeq = Math.max(0, json.optLong("lastEventSeq", 0));
        connection.lastNotifiedSeq = Math.max(0, json.optLong("lastNotifiedSeq", 0));
        connection.activityNotifications = json.optBoolean("activityNotifications", true);
        JSONArray endpoints = json.optJSONArray("knownEndpoints");
        if (endpoints != null) {
            for (int i = 0; i < endpoints.length(); i++) {
                connection.addEndpoint(endpoints.optString(i, ""));
            }
        }
        return connection;
    }

    public JSONObject toJson() {
        JSONObject json = new JSONObject();
        try {
            json.put("connectionId", connectionId);
            json.put("coreId", coreId);
            json.put("name", name);
            json.put("token", token);
            json.put("knownEndpoints", new JSONArray(knownEndpoints));
            json.put("lastWorkingEndpoint", safe(lastWorkingEndpoint));
            json.put("lastSeenAt", safe(lastSeenAt));
            json.put("status", safe(status));
            json.put("statusMessage", safe(statusMessage));
            json.put("lastEventSeq", Math.max(0, lastEventSeq));
            json.put("lastNotifiedSeq", Math.max(0, lastNotifiedSeq));
            json.put("activityNotifications", activityNotifications);
        } catch (Exception ignored) {
        }
        return json;
    }

    public boolean hasToken() {
        return token != null && !token.isEmpty();
    }

    public void addEndpoint(String endpoint) {
        String normalized = trimTrailingSlash(endpoint);
        if (normalized.isEmpty()) return;
        Set<String> next = new LinkedHashSet<>(knownEndpoints);
        next.add(normalized);
        knownEndpoints.clear();
        knownEndpoints.addAll(next);
    }

    public void markOnline(String endpoint) {
        lastWorkingEndpoint = trimTrailingSlash(endpoint);
        addEndpoint(endpoint);
        lastSeenAt = Instant.now().toString();
        status = "online";
        statusMessage = "Connected to " + hostLabel(endpoint);
    }

    public void markOffline(String message) {
        status = "offline";
        statusMessage = message == null || message.isEmpty() ? "ForgeAgent is not reachable." : message;
    }

    public String displayEndpoint() {
        if (lastWorkingEndpoint != null && !lastWorkingEndpoint.isEmpty()) return lastWorkingEndpoint;
        return knownEndpoints.isEmpty() ? "" : knownEndpoints.get(0);
    }

    public static String trimTrailingSlash(String value) {
        if (value == null) return "";
        String next = value.trim();
        while (next.endsWith("/")) next = next.substring(0, next.length() - 1);
        return next;
    }

    public static String hostLabel(String value) {
        try {
            URL url = new URL(value);
            return url.getHost() == null || url.getHost().isEmpty() ? "ForgeAgent Desktop" : url.getHost();
        } catch (Exception ignored) {
            return value == null || value.isEmpty() ? "ForgeAgent Desktop" : value;
        }
    }

    private static String safe(String value) {
        return value == null ? "" : value;
    }
}
