package gg.llll.app;

import android.os.Build;
import android.os.Bundle;
import android.view.View;
import android.webkit.WebView;
import androidx.activity.OnBackPressedCallback;
import androidx.core.view.ViewCompat;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        registerPlugin(ServerBridgePlugin.class);
        super.onCreate(savedInstanceState);
        // Before Android 15 the window already shrinks above the keyboard. Capacitor's padding
        // for edge-to-edge would take the keyboard's height off a second time.
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.VANILLA_ICE_CREAM) {
            View container = (View) getBridge().getWebView().getParent();
            ViewCompat.setOnApplyWindowInsetsListener(container, (view, insets) -> {
                view.setPadding(0, 0, 0, 0);
                return insets;
            });
        }
        // Back walks a Server's history, then returns to the Server list.
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                WebView webView = getBridge().getWebView();
                if (webView.canGoBack()) {
                    webView.goBack();
                    return;
                }
                // A Server opened at launch has no list behind it in history.
                String url = webView.getUrl();
                String list = getBridge().getAppUrl();
                if (url != null && !url.startsWith(list)) {
                    webView.loadUrl(list + "#servers");
                    return;
                }
                setEnabled(false);
                getOnBackPressedDispatcher().onBackPressed();
            }
        });
    }
}
