package dev.forgeagent.android;

import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.Set;

public final class EndpointResolver {
    public static final class Result {
        public final boolean ok;
        public final String endpoint;
        public final String message;

        private Result(boolean ok, String endpoint, String message) {
            this.ok = ok;
            this.endpoint = endpoint;
            this.message = message;
        }

        static Result ok(String endpoint, String message) {
            return new Result(true, endpoint, message);
        }

        static Result error(String message) {
            return new Result(false, "", message);
        }
    }

    private final ConnectionStore store;

    public EndpointResolver(ConnectionStore store) {
        this.store = store;
    }

    public Result resolve(ForgeConnection connection) {
        if (connection == null) return Result.error("No ForgeAgent connection is selected.");
        if (!connection.hasToken()) return Result.error("This connection is missing its device token. Pair it again from the Mac.");
        ArrayList<String> candidates = candidates(connection);
        if (candidates.isEmpty()) return Result.error("This connection has no saved address. Add a remote URL or pair again.");

        String lastError = "";
        for (String endpoint : candidates) {
            try {
                IdentityProbe identity = probeIdentity(endpoint);
                if (!identity.isForgeAgent) {
                    lastError = host(endpoint) + " does not look like a ForgeAgent gateway. It returned " + identity.message + ".";
                    continue;
                }
                if (
                    connection.coreId != null &&
                    !connection.coreId.isEmpty() &&
                    !identity.coreId.isEmpty() &&
                    !connection.coreId.equals(identity.coreId)
                ) {
                    lastError = host(endpoint) + " is a different ForgeAgent desktop.";
                    continue;
                }
                if (connection.coreId != null && !connection.coreId.isEmpty() && identity.coreId.isEmpty()) {
                    lastError = host(endpoint) + " is ForgeAgent, but it does not expose a desktop identity. Restart or update the Mac app, then retry.";
                    continue;
                }

                JSONObject deviceState = getJson(endpoint, "/device-state", connection.token);
                if (deviceState.optString("deviceId", "").isEmpty()) {
                    lastError = host(endpoint) + " did not accept this Android device token.";
                    continue;
                }

                if (!identity.coreId.isEmpty()) connection.coreId = identity.coreId;
                String desktopName = identity.desktopName;
                if (desktopName.length() > 0 && (connection.name == null || connection.name.isEmpty() || "ForgeAgent Desktop".equals(connection.name) || connection.name.equals(host(connection.displayEndpoint())))) {
                    connection.name = desktopName;
                }
                connection.markOnline(endpoint);
                store.upsert(connection);
                return Result.ok(endpoint, "Connected to " + connection.name + ".");
            } catch (HttpStatusException ex) {
                if (ex.status == 401 || ex.status == 403) {
                    connection.markOffline("This Android device token was rejected by " + host(endpoint) + ". Pair again from the Mac.");
                    store.upsert(connection);
                    return Result.error(connection.statusMessage);
                }
                lastError = host(endpoint) + " returned HTTP " + ex.status + ".";
            } catch (NonJsonResponseException ex) {
                lastError = host(endpoint) + " returned a web page instead of the ForgeAgent API. Restart or update the Mac app and retry.";
            } catch (Exception ex) {
                lastError = "Cannot reach " + host(endpoint) + ": " + (ex.getMessage() == null ? ex.toString() : ex.getMessage());
            }
        }

        connection.markOffline(lastError.isEmpty()
            ? "ForgeAgent is not reachable. Use the same Wi-Fi, Tailscale, ZeroTier, or a configured remote URL."
            : lastError);
        store.upsert(connection);
        return Result.error(connection.statusMessage);
    }

    private ArrayList<String> candidates(ForgeConnection connection) {
        Set<String> values = new LinkedHashSet<>();
        if (connection.lastWorkingEndpoint != null && !connection.lastWorkingEndpoint.isEmpty()) {
            values.add(ForgeConnection.trimTrailingSlash(connection.lastWorkingEndpoint));
        }
        for (String endpoint : connection.knownEndpoints) {
            String normalized = ForgeConnection.trimTrailingSlash(endpoint);
            if (!normalized.isEmpty()) values.add(normalized);
        }
        return new ArrayList<>(values);
    }

    private IdentityProbe probeIdentity(String endpoint) {
        String lastMessage = "an unknown response";
        String[] paths = new String[]{"/identity", "/discovery", "/health"};
        for (String path : paths) {
            try {
                JSONObject json = getJson(endpoint, path, "");
                String app = json.optString("app", "");
                String coreId = json.optString("coreId", "");
                if ("ForgeAgent".equals(app) || coreId.startsWith("forge-core-")) {
                    return new IdentityProbe(
                        true,
                        coreId,
                        json.optString("desktopName", ForgeConnection.hostLabel(endpoint)),
                        path
                    );
                }
                lastMessage = "JSON without a ForgeAgent identity from " + path;
            } catch (NonJsonResponseException ex) {
                lastMessage = ex.message;
            } catch (HttpStatusException ex) {
                lastMessage = "HTTP " + ex.status + " from " + path;
            } catch (Exception ex) {
                lastMessage = ex.getMessage() == null ? ex.toString() : ex.getMessage();
            }
        }
        return new IdentityProbe(false, "", "", lastMessage);
    }

    private JSONObject getJson(String endpoint, String path, String token) throws Exception {
        URL url = new URL(ForgeConnection.trimTrailingSlash(endpoint) + path);
        HttpURLConnection connection = (HttpURLConnection) url.openConnection();
        connection.setRequestMethod("GET");
        connection.setConnectTimeout(8_000);
        connection.setReadTimeout(12_000);
        if (token != null && !token.isEmpty()) {
            connection.setRequestProperty("Authorization", "Bearer " + token);
        }
        int status = connection.getResponseCode();
        InputStream stream = status >= 200 && status < 300 ? connection.getInputStream() : connection.getErrorStream();
        String text = readAll(stream);
        if (status < 200 || status >= 300) throw new HttpStatusException(status, text);
        if (text == null || text.isEmpty()) return new JSONObject();
        String trimmed = text.trim();
        if (!trimmed.startsWith("{")) {
            throw new NonJsonResponseException("a non-JSON response: " + snippet(trimmed));
        }
        return new JSONObject(trimmed);
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

    private String host(String endpoint) {
        return ForgeConnection.hostLabel(endpoint);
    }

    private String snippet(String value) {
        String clean = value == null ? "" : value.replaceAll("\\s+", " ").trim();
        if (clean.length() <= 80) return clean;
        return clean.substring(0, 79) + "…";
    }

    private static final class IdentityProbe {
        final boolean isForgeAgent;
        final String coreId;
        final String desktopName;
        final String message;

        IdentityProbe(boolean isForgeAgent, String coreId, String desktopName, String message) {
            this.isForgeAgent = isForgeAgent;
            this.coreId = coreId == null ? "" : coreId;
            this.desktopName = desktopName == null ? "" : desktopName;
            this.message = message == null ? "" : message;
        }
    }

    private static final class NonJsonResponseException extends Exception {
        final String message;

        NonJsonResponseException(String message) {
            super(message);
            this.message = message;
        }
    }

    private static final class HttpStatusException extends Exception {
        final int status;

        HttpStatusException(int status, String body) {
            super(body == null || body.isEmpty() ? "HTTP " + status : body);
            this.status = status;
        }
    }
}
