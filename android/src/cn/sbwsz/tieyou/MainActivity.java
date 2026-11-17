package cn.sbwsz.tieyou;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.view.View;
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

import java.io.IOException;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.Collections;
import java.util.Locale;

public final class MainActivity extends Activity {
    private static final String SITE_HOST = "sbwsz.cn";
    private static final String HOME = "https://" + SITE_HOST + "/";
    private static final int CHOOSE_FILE = 1;
    private static final int SAVE_FILE = 2;

    private WebView web;
    private ValueCallback<Uri[]> upload;
    private String exportContent;

    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        int background = Color.rgb(246, 246, 239);
        getWindow().setStatusBarColor(background);
        getWindow().setNavigationBarColor(background);
        getWindow().getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR);
        web = new WebView(this);
        web.setBackgroundColor(background);
        web.getSettings().setJavaScriptEnabled(true);
        web.getSettings().setDomStorageEnabled(true);
        web.getSettings().setAllowFileAccess(false);
        web.getSettings().setAllowContentAccess(false);
        CookieManager.getInstance().setAcceptCookie(true);
        web.addJavascriptInterface(new DeckFiles(), "TieyouDeckFiles");

        web.setWebViewClient(new WebViewClient() {
            @Override public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                Uri url = request.getUrl();
                if (!isSite(url) || !"GET".equals(request.getMethod())) return null;
                String path = url.getPath();
                if (path == null || path.equals("/")) path = "/index.html";
                // The app bundles UI assets. API requests still go to the same HTTPS origin.
                if (!path.matches("/[A-Za-z0-9_./-]+") || path.contains("..") ||
                        path.startsWith("/api/")) return null;
                String type = mimeType(path);
                if (type == null) return null;
                try {
                    WebResourceResponse response = new WebResourceResponse(type, path.endsWith(".png") ? null : "UTF-8",
                            getAssets().open("web" + path));
                    if (path.equals("/index.html")) {
                        response.setResponseHeaders(Collections.singletonMap("Content-Security-Policy",
                                "script-src 'self' 'unsafe-inline'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'"));
                    }
                    return response;
                } catch (IOException missingAsset) {
                    return null;
                }
            }

            @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri url = request.getUrl();
                if (request.isForMainFrame() && isSite(url) &&
                        ("/".equals(url.getPath()) || "/index.html".equals(url.getPath()))) return false;
                if (request.isForMainFrame() && "https".equals(url.getScheme())) {
                    try { startActivity(new Intent(Intent.ACTION_VIEW, url)); }
                    catch (ActivityNotFoundException ignored) { }
                }
                return true;
            }
        });

        web.setWebChromeClient(new WebChromeClient() {
            @Override public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> result, FileChooserParams params) {
                if (upload != null) upload.onReceiveValue(null);
                upload = result;
                try { startActivityForResult(params.createIntent(), CHOOSE_FILE); }
                catch (ActivityNotFoundException ignored) {
                    upload = null;
                    result.onReceiveValue(null);
                }
                return true;
            }
        });
        setContentView(web);
        web.loadUrl(HOME);
    }

    private static boolean isSite(Uri url) {
        return "https".equals(url.getScheme()) && SITE_HOST.equals(url.getHost()) &&
                (url.getPort() == -1 || url.getPort() == 443);
    }

    private static String mimeType(String path) {
        if (path.endsWith(".html")) return "text/html";
        if (path.endsWith(".js")) return "text/javascript";
        if (path.endsWith(".css")) return "text/css";
        if (path.endsWith(".json")) return "application/json";
        if (path.endsWith(".svg")) return "image/svg+xml";
        if (path.endsWith(".png")) return "image/png";
        if (path.endsWith(".md")) return "text/plain";
        return null;
    }

    private final class DeckFiles {
        @JavascriptInterface public void save(String filename, String content) {
            if (filename == null || content == null || content.length() > 10_000_000) return;
            runOnUiThread(() -> {
                if (!isSite(Uri.parse(web.getUrl() == null ? "" : web.getUrl())) || exportContent != null) return;
                String name = filename.replaceAll("[\\\\/:*?\"<>|\\p{Cntrl}]", "_");
                String type = name.toLowerCase(Locale.ROOT).endsWith(".json") ? "application/json" : "text/plain";
                Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT)
                        .addCategory(Intent.CATEGORY_OPENABLE).setType(type).putExtra(Intent.EXTRA_TITLE, name);
                exportContent = content;
                try { startActivityForResult(intent, SAVE_FILE); }
                catch (ActivityNotFoundException ignored) {
                    exportContent = null;
                    Toast.makeText(MainActivity.this, "无法打开文件保存窗口", Toast.LENGTH_SHORT).show();
                }
            });
        }
    }

    @Override protected void onActivityResult(int request, int result, Intent data) {
        super.onActivityResult(request, result, data);
        if (request == CHOOSE_FILE && upload != null) {
            ValueCallback<Uri[]> callback = upload;
            upload = null;
            callback.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(result, data));
        }
        if (request != SAVE_FILE) return;
        String content = exportContent;
        exportContent = null;
        if (result != RESULT_OK || data == null || data.getData() == null || content == null) return;
        try (OutputStream stream = getContentResolver().openOutputStream(data.getData())) {
            if (stream == null) throw new IOException("No output stream");
            stream.write(content.getBytes(StandardCharsets.UTF_8));
        } catch (IOException failure) {
            Toast.makeText(this, "保存牌组文件失败", Toast.LENGTH_SHORT).show();
        }
    }

    @Override public void onBackPressed() {
        web.evaluateJavascript("window.tieyouHandleBack?.() || false", result -> {
            if ("true".equals(result)) return;
            if (web.canGoBack()) web.goBack();
            else super.onBackPressed();
        });
    }
}
