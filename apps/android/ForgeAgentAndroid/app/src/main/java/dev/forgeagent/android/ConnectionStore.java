package dev.forgeagent.android;

import android.content.Context;
import android.content.SharedPreferences;

import org.json.JSONArray;

import java.util.ArrayList;
import java.util.Iterator;

public final class ConnectionStore {
    private static final String KEY_CONNECTIONS = "connections.v1";
    private static final String KEY_ACTIVE_CONNECTION_ID = "activeConnectionId";
    private static final String KEY_LEGACY_MIGRATED = "legacyConnectionMigrated";

    private final SharedPreferences prefs;

    public ConnectionStore(Context context) {
        this.prefs = context.getSharedPreferences(MainActivity.PREFS, Context.MODE_PRIVATE);
        migrateLegacyIfNeeded();
    }

    public synchronized ArrayList<ForgeConnection> list() {
        ArrayList<ForgeConnection> result = new ArrayList<>();
        String raw = prefs.getString(KEY_CONNECTIONS, "[]");
        try {
            JSONArray array = new JSONArray(raw);
            for (int i = 0; i < array.length(); i++) {
                if (array.optJSONObject(i) != null) {
                    ForgeConnection connection = ForgeConnection.fromJson(array.optJSONObject(i));
                    if (connection.connectionId != null && !connection.connectionId.isEmpty()) {
                        result.add(connection);
                    }
                }
            }
        } catch (Exception ignored) {
        }
        return result;
    }

    public synchronized ForgeConnection get(String connectionId) {
        if (connectionId == null || connectionId.isEmpty()) return null;
        for (ForgeConnection connection : list()) {
            if (connectionId.equals(connection.connectionId)) return connection;
        }
        return null;
    }

    public synchronized ForgeConnection active() {
        String activeId = prefs.getString(KEY_ACTIVE_CONNECTION_ID, "");
        ForgeConnection active = get(activeId);
        if (active != null) return active;
        ArrayList<ForgeConnection> all = list();
        return all.isEmpty() ? null : all.get(0);
    }

    public synchronized String activeId() {
        String activeId = prefs.getString(KEY_ACTIVE_CONNECTION_ID, "");
        if (activeId != null && !activeId.isEmpty()) return activeId;
        ForgeConnection active = active();
        return active == null ? "" : active.connectionId;
    }

    public synchronized void setActive(String connectionId) {
        if (connectionId == null || connectionId.isEmpty()) return;
        prefs.edit().putString(KEY_ACTIVE_CONNECTION_ID, connectionId).apply();
    }

    public synchronized void upsert(ForgeConnection next) {
        if (next == null || next.connectionId == null || next.connectionId.isEmpty()) return;
        ArrayList<ForgeConnection> all = list();
        boolean replaced = false;
        for (int i = 0; i < all.size(); i++) {
            if (next.connectionId.equals(all.get(i).connectionId)) {
                all.set(i, next);
                replaced = true;
                break;
            }
        }
        if (!replaced) all.add(next);
        save(all);
        String activeId = prefs.getString(KEY_ACTIVE_CONNECTION_ID, "");
        if (activeId == null || activeId.isEmpty()) setActive(next.connectionId);
    }

    public synchronized void delete(String connectionId) {
        ArrayList<ForgeConnection> all = list();
        Iterator<ForgeConnection> iterator = all.iterator();
        while (iterator.hasNext()) {
            if (connectionId.equals(iterator.next().connectionId)) iterator.remove();
        }
        save(all);
        if (connectionId.equals(prefs.getString(KEY_ACTIVE_CONNECTION_ID, ""))) {
            prefs.edit().putString(KEY_ACTIVE_CONNECTION_ID, all.isEmpty() ? "" : all.get(0).connectionId).apply();
        }
    }

    public synchronized boolean hasAnyToken() {
        for (ForgeConnection connection : list()) {
            if (connection.hasToken()) return true;
        }
        return false;
    }

    private void save(ArrayList<ForgeConnection> all) {
        JSONArray array = new JSONArray();
        for (ForgeConnection connection : all) {
            array.put(connection.toJson());
        }
        prefs.edit().putString(KEY_CONNECTIONS, array.toString()).apply();
    }

    private void migrateLegacyIfNeeded() {
        if (prefs.getBoolean(KEY_LEGACY_MIGRATED, false)) return;
        String token = prefs.getString(MainActivity.PREF_TOKEN, "");
        String baseUrl = prefs.getString(MainActivity.PREF_BASE_URL, "");
        if (token != null && !token.isEmpty()) {
            ForgeConnection connection = ForgeConnection.legacy(
                baseUrl == null || baseUrl.isEmpty() ? "http://127.0.0.1:3000" : baseUrl,
                token,
                prefs.getLong(MainActivity.PREF_LAST_EVENT_SEQ, 0),
                prefs.getLong(MainActivity.PREF_LAST_NOTIFIED_SEQ, 0),
                prefs.getBoolean(MainActivity.PREF_ACTIVITY_NOTIFICATIONS, true)
            );
            ArrayList<ForgeConnection> all = list();
            all.add(connection);
            save(all);
            prefs.edit()
                .putString(KEY_ACTIVE_CONNECTION_ID, connection.connectionId)
                .remove(MainActivity.PREF_TOKEN)
                .remove(MainActivity.PREF_BASE_URL)
                .remove(MainActivity.PREF_LAST_EVENT_SEQ)
                .remove(MainActivity.PREF_LAST_NOTIFIED_SEQ)
                .putBoolean(KEY_LEGACY_MIGRATED, true)
                .apply();
            return;
        }
        prefs.edit().putBoolean(KEY_LEGACY_MIGRATED, true).apply();
    }
}
