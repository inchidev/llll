package gg.llll.app;

import android.Manifest;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.webkit.WebView;
import androidx.activity.result.ActivityResultLauncher;
import androidx.activity.result.contract.ActivityResultContracts;
import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import androidx.core.content.ContextCompat;
import androidx.webkit.JavaScriptReplyProxy;
import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * Opens each Server's own Client inside the app. Only the bundled Server list
 * can allow a Server, and only allowed origins get the notification bridge;
 * any other link opens in the browser.
 */
@CapacitorPlugin(name = "ServerBridge")
public class ServerBridgePlugin extends Plugin {

    private static final String CHANNEL_ID = "messages";
    private static final String LISTENER_NAME = "l4Native";
    private static final String URL_EXTRA = "gg.llll.app.url";

    private final Set<String> allowedOrigins = new HashSet<>();
    private final List<PendingReply> permissionReplies = new ArrayList<>();
    private ActivityResultLauncher<String> permissionLauncher;
    private ServerRail rail;

    private record PendingReply(JavaScriptReplyProxy proxy, int id) {}

    @Override
    public void load() {
        installBridge();
        rail = new ServerRail(getBridge(), this::openFromRail);
        permissionLauncher = getActivity().registerForActivityResult(new ActivityResultContracts.RequestPermission(), granted -> {
            for (PendingReply reply : permissionReplies) respond(reply.proxy(), reply.id(), granted ? "subscribed" : "blocked");
            permissionReplies.clear();
        });
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationManager manager = getContext().getSystemService(NotificationManager.class);
            manager.createNotificationChannel(new NotificationChannel(CHANNEL_ID, "Messages", NotificationManager.IMPORTANCE_HIGH));
        }
    }

    @PluginMethod
    public void allow(PluginCall call) {
        // Plugin methods run on a background thread; WebView needs the main one.
        getBridge().executeOnMainThread(() -> allowOnMainThread(call));
    }

    private void allowOnMainThread(PluginCall call) {
        Uri uri = Uri.parse(call.getString("origin", ""));
        String origin = originOf(uri);
        boolean local = "localhost".equals(uri.getHost()) || "127.0.0.1".equals(uri.getHost());
        if (origin == null || !("https".equals(uri.getScheme()) || ("http".equals(uri.getScheme()) && local))) {
            call.reject("L4 servers must use HTTPS");
            return;
        }
        allowedOrigins.add(origin);
        call.resolve();
    }

    /** The rail is the app's own page, and the list it reads is the device's. */
    private void openFromRail(String address) {
        String origin = originOf(Uri.parse(address));
        if (origin == null || !address.equals(origin)) return;
        allowedOrigins.add(origin);
        getBridge().getWebView().loadUrl(origin + "/");
    }

    @Override
    public Boolean shouldOverrideLoad(Uri url) {
        String origin = originOf(url);
        return origin != null && allowedOrigins.contains(origin) ? Boolean.FALSE : null;
    }

    @Override
    protected void handleOnNewIntent(Intent intent) {
        super.handleOnNewIntent(intent);
        String url = intent.getStringExtra(URL_EXTRA);
        if (url == null) return;
        String origin = originOf(Uri.parse(url));
        if (origin != null && allowedOrigins.contains(origin)) getBridge().getWebView().loadUrl(url);
    }

    /**
     * Once, before any page: adding a script or listener while a page is open crashes WebView at that
     * page's next native call. Both cover every origin, and only allowed Servers get an answer.
     */
    private void installBridge() {
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT) || !WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) return;
        WebView webView = getBridge().getWebView();
        try {
            WebViewCompat.addDocumentStartJavaScript(webView, readBridge(), Set.of("*"));
        } catch (IOException exception) {
            // Without the script the Client still opens, without native notifications.
            return;
        }
        WebViewCompat.addWebMessageListener(webView, LISTENER_NAME, Set.of("*"), (view, message, sourceOrigin, isMainFrame, proxy) -> {
            if (!isMainFrame || message.getData() == null || !allowedOrigins.contains(sourceOrigin.toString())) return;
            try {
                handle(new JSONObject(message.getData()), sourceOrigin.toString(), proxy);
            } catch (JSONException ignored) {
                // Only the injected bridge posts here, and it always sends JSON.
            }
        });
    }

    private void handle(JSONObject message, String origin, JavaScriptReplyProxy proxy) throws JSONException {
        int id = message.getInt("id");
        switch (message.getString("method")) {
            case "permission" -> respond(proxy, id, permission());
            case "enable" -> {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU && !"subscribed".equals(permission())) {
                    permissionReplies.add(new PendingReply(proxy, id));
                    permissionLauncher.launch(Manifest.permission.POST_NOTIFICATIONS);
                } else {
                    respond(proxy, id, permission());
                }
            }
            case "clear" -> {
                NotificationManagerCompat.from(getContext()).cancelAll();
                respond(proxy, id, "ok");
            }
            case "notify" -> {
                notify(message.getJSONObject("notification"), origin);
                respond(proxy, id, "ok");
            }
            case "open" -> {
                openExternal(message.getString("url"));
                respond(proxy, id, "ok");
            }
            case "servers" -> {
                getBridge().getWebView().loadUrl(getBridge().getAppUrl() + "#servers");
                respond(proxy, id, "ok");
            }
            case "rail" -> {
                if (rail != null) rail.setWanted(message.optBoolean("visible"));
                respond(proxy, id, "ok");
            }
            default -> respond(proxy, id, "error");
        }
    }

    private String permission() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU && ContextCompat.checkSelfPermission(getContext(), Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) return "prompt";
        return NotificationManagerCompat.from(getContext()).areNotificationsEnabled() ? "subscribed" : "blocked";
    }

    private void notify(JSONObject notification, String origin) throws JSONException {
        if (!"subscribed".equals(permission())) return;
        String url = origin + notification.optString("url", "/");
        Intent intent = new Intent(getContext(), MainActivity.class).putExtra(URL_EXTRA, url).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
        String key = origin + notification.getString("id");
        PendingIntent open = PendingIntent.getActivity(getContext(), key.hashCode(), intent, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        NotificationCompat.Builder builder = new NotificationCompat.Builder(getContext(), CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(notification.getString("title"))
            .setContentText(notification.getString("body"))
            .setStyle(new NotificationCompat.BigTextStyle().bigText(notification.getString("body")))
            .setNumber(notification.optInt("badge"))
            .setGroup(origin)
            .setAutoCancel(true)
            .setContentIntent(open);
        try {
            NotificationManagerCompat.from(getContext()).notify(key.hashCode(), builder.build());
        } catch (SecurityException ignored) {
            // Permission was revoked after the check above.
        }
    }

    private void openExternal(String url) {
        Uri uri = Uri.parse(url);
        if (!"https".equals(uri.getScheme()) && !"http".equals(uri.getScheme())) return;
        getActivity().startActivity(new Intent(Intent.ACTION_VIEW, uri));
    }

    private void respond(JavaScriptReplyProxy proxy, int id, String result) {
        try {
            proxy.postMessage(new JSONObject().put("id", id).put("result", result).toString());
        } catch (JSONException ignored) {
            // A string and an integer always serialize.
        }
    }

    private String readBridge() throws IOException {
        try (InputStream input = getContext().getAssets().open("public/native-bridge-android.js"); ByteArrayOutputStream output = new ByteArrayOutputStream()) {
            // By hand: transferTo and toString(Charset) only exist from Android 13.
            byte[] buffer = new byte[8192];
            for (int read; (read = input.read(buffer)) != -1; ) output.write(buffer, 0, read);
            return output.toString("UTF-8");
        }
    }

    private static String originOf(Uri uri) {
        if (uri.getScheme() == null || uri.getHost() == null) return null;
        return uri.getScheme() + "://" + uri.getHost() + (uri.getPort() == -1 ? "" : ":" + uri.getPort());
    }
}
