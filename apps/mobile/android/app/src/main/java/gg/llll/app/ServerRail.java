package gg.llll.app;

import android.annotation.SuppressLint;
import android.graphics.Color;
import android.net.Uri;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import androidx.webkit.WebViewAssetLoader;
import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;
import com.getcapacitor.Bridge;
import com.getcapacitor.WebViewListener;
import java.util.Set;
import java.util.function.Consumer;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * The Server rail, in its own WebView at the app's own address beside the one showing a Server,
 * so a Server's page can't reach it or the list it reads. On a phone it shows only when the page
 * says it has room.
 */
final class ServerRail {

    private static final String APP_ORIGIN = "https://localhost";
    private static final int WIDTH_DP = 72;
    private static final int TABLET_WIDTH_DP = 768;

    private final Bridge bridge;
    private final Consumer<String> open;
    private WebView rail;
    private boolean wanted;
    private String server;

    @SuppressLint("SetJavaScriptEnabled")
    ServerRail(Bridge bridge, Consumer<String> open) {
        this.bridge = bridge;
        this.open = open;
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) return;
        WebView page = bridge.getWebView();
        if (!(page.getParent() instanceof ViewGroup parent)) return;

        rail = new WebView(page.getContext());
        rail.setBackgroundColor(Color.BLACK);
        rail.getSettings().setJavaScriptEnabled(true);
        rail.getSettings().setDomStorageEnabled(true);
        WebViewAssetLoader assets = new WebViewAssetLoader.Builder()
            .setDomain("localhost")
            .addPathHandler("/assets/", new WebViewAssetLoader.AssetsPathHandler(page.getContext()))
            .build();
        rail.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                return assets.shouldInterceptRequest(request.getUrl());
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                return true;
            }
        });
        WebViewCompat.addWebMessageListener(rail, "l4Rail", Set.of(APP_ORIGIN), (view, message, sourceOrigin, isMainFrame, proxy) -> {
            if (isMainFrame && message.getData() != null) receive(message.getData());
        });
        rail.setVisibility(View.GONE);
        parent.addView(rail, new ViewGroup.MarginLayoutParams(dp(WIDTH_DP), ViewGroup.LayoutParams.MATCH_PARENT));
        rail.loadUrl(APP_ORIGIN + "/assets/public/rail.html");

        bridge.addWebViewListener(new WebViewListener() {
            @Override
            public void onPageStarted(WebView webView) {
                pageChanged(webView.getUrl());
            }

            @Override
            public void onPageLoaded(WebView webView) {
                pageChanged(webView.getUrl());
            }
        });
    }

    void setWanted(boolean value) {
        wanted = value;
        layout();
    }

    private void receive(String data) {
        try {
            JSONObject message = new JSONObject(data);
            switch (message.getString("type")) {
                case "ready" -> tellActive();
                case "list" -> bridge.getWebView().loadUrl(bridge.getAppUrl() + "#servers");
                case "open" -> open.accept(message.getString("origin"));
                default -> { }
            }
        } catch (JSONException ignored) {
            // Only the rail's own page posts here, and it always sends JSON.
        }
    }

    private void pageChanged(String url) {
        String origin = serverOrigin(url);
        if (origin == null ? server == null : origin.equals(server)) return;
        server = origin;
        // A new page says for itself whether it has room.
        wanted = false;
        tellActive();
        layout();
    }

    private String serverOrigin(String url) {
        if (url == null || url.startsWith(bridge.getAppUrl()) || url.startsWith(APP_ORIGIN)) return null;
        Uri uri = Uri.parse(url);
        if (uri.getHost() == null || !("https".equals(uri.getScheme()) || "http".equals(uri.getScheme()))) return null;
        return uri.getScheme() + "://" + uri.getHost() + (uri.getPort() == -1 ? "" : ":" + uri.getPort());
    }

    private void tellActive() {
        if (rail == null) return;
        String value = server == null ? "null" : JSONObject.quote(server);
        rail.evaluateJavascript("window.__L4_RAIL__ && window.__L4_RAIL__.setActive(" + value + ")", null);
    }

    private void layout() {
        if (rail == null) return;
        WebView page = bridge.getWebView();
        boolean wide = page.getResources().getConfiguration().screenWidthDp >= TABLET_WIDTH_DP;
        boolean show = server != null && (wanted || wide);
        rail.setVisibility(show ? View.VISIBLE : View.GONE);
        ViewGroup.MarginLayoutParams params = (ViewGroup.MarginLayoutParams) page.getLayoutParams();
        int left = show ? dp(WIDTH_DP) : 0;
        if (params.leftMargin != left) {
            params.leftMargin = left;
            page.setLayoutParams(params);
        }
    }

    private int dp(int value) {
        return Math.round(value * bridge.getWebView().getResources().getDisplayMetrics().density);
    }
}
