package cn.sbwsz.tieyou;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.ContentValues;
import android.content.Intent;
import android.graphics.BitmapFactory;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.MediaStore;
import android.util.Base64;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;
import android.widget.Toast;
import org.json.JSONObject;

import java.io.IOException;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.function.BooleanSupplier;

/** Writes generated PNG bytes locally. No URL navigation or network request is needed. */
final class ImageSaves {
    static final int PICK_DESTINATION = 3;
    private final Activity activity;
    private final WebView web;
    private final BooleanSupplier trustedPage;
    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private String activeRequest;
    private byte[] pendingBytes;
    private boolean destroyed;

    ImageSaves(Activity activity, WebView web, BooleanSupplier trustedPage) {
        this.activity = activity; this.web = web; this.trustedPage = trustedPage;
    }

    @JavascriptInterface public void save(String requestId, String filename, String encoded) {
        if (requestId == null || !requestId.matches("[A-Za-z0-9_-]{1,80}")) return;
        activity.runOnUiThread(() -> {
            if (destroyed || !trustedPage.getAsBoolean()) return;
            if (activeRequest != null) { reply(requestId, false, false, "正在保存图片，请稍候"); return; }
            activeRequest = requestId;
            if (encoded == null || encoded.length() > 11_200_000) { reply(requestId, false, false, "图片过大，无法保存"); return; }
            worker.execute(() -> {
                try {
                    byte[] bytes = Base64.decode(encoded, Base64.DEFAULT);
                    validate(bytes);
                    String name = safeName(filename);
                    if (Build.VERSION.SDK_INT >= 29) {
                        saveToGallery(bytes, name);
                        reply(requestId, true, false, "已保存到相册「铁有」");
                    } else {
                        activity.runOnUiThread(() -> pickDestination(requestId, bytes, name));
                    }
                } catch (Exception failure) { reply(requestId, false, false, "图片保存失败，请重试"); }
            });
        });
    }

    private static void validate(byte[] bytes) throws IOException {
        if (bytes.length < 57 || bytes.length > 8 * 1024 * 1024 || bytes[0] != (byte) 137 || bytes[1] != 80 || bytes[2] != 78 || bytes[3] != 71
                || bytes[4] != 13 || bytes[5] != 10 || bytes[6] != 26 || bytes[7] != 10) throw new IOException("Invalid PNG");
        BitmapFactory.Options bounds = new BitmapFactory.Options(); bounds.inJustDecodeBounds = true;
        BitmapFactory.decodeByteArray(bytes, 0, bytes.length, bounds);
        if (bounds.outWidth != 1440 || bounds.outHeight < 1000 || bounds.outHeight > 8192 || !"image/png".equals(bounds.outMimeType)) throw new IOException("Invalid PNG dimensions");
    }

    private static String safeName(String filename) {
        String name = filename == null ? "铁有卡组" : filename.replaceAll("[\\\\/:*?\"<>|\\p{Cntrl}]", "_").trim();
        if (name.toLowerCase(java.util.Locale.ROOT).endsWith(".png")) name = name.substring(0, name.length() - 4);
        if (name.isEmpty()) name = "铁有卡组";
        while (name.getBytes(StandardCharsets.UTF_8).length > 200) name = name.substring(0, name.offsetByCodePoints(name.length(), -1));
        return name + ".png";
    }

    private void saveToGallery(byte[] bytes, String filename) throws IOException {
        ContentValues values = new ContentValues();
        values.put(MediaStore.Images.Media.DISPLAY_NAME, filename);
        values.put(MediaStore.Images.Media.MIME_TYPE, "image/png");
        values.put(MediaStore.Images.Media.RELATIVE_PATH, Environment.DIRECTORY_PICTURES + "/铁有");
        values.put(MediaStore.Images.Media.IS_PENDING, 1);
        Uri destination = activity.getContentResolver().insert(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, values);
        if (destination == null) throw new IOException("No gallery destination");
        boolean published = false;
        try {
            try (OutputStream output = activity.getContentResolver().openOutputStream(destination)) {
                if (output == null) throw new IOException("No image output");
                output.write(bytes);
            }
            ContentValues ready = new ContentValues(); ready.put(MediaStore.Images.Media.IS_PENDING, 0);
            if (activity.getContentResolver().update(destination, ready, null, null) != 1) throw new IOException("Image was not published");
            published = true;
        } finally {
            if (!published) activity.getContentResolver().delete(destination, null, null);
        }
    }

    private void pickDestination(String requestId, byte[] bytes, String filename) {
        if (destroyed) return;
        if (!trustedPage.getAsBoolean()) { reply(requestId, false, true, ""); return; }
        pendingBytes = bytes;
        Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType("image/png").putExtra(Intent.EXTRA_TITLE, filename);
        try { activity.startActivityForResult(intent, PICK_DESTINATION); }
        catch (ActivityNotFoundException failure) { pendingBytes = null; reply(requestId, false, false, "无法打开系统保存窗口"); }
    }

    void activityResult(int request, int result, Intent data) {
        if (request != PICK_DESTINATION) return;
        final String requestId = activeRequest;
        final byte[] bytes = pendingBytes; pendingBytes = null;
        if (requestId == null || bytes == null) return;
        final Uri destination = data == null ? null : data.getData();
        if (result != Activity.RESULT_OK || destination == null) { reply(requestId, false, true, ""); return; }
        worker.execute(() -> {
            try {
                try (OutputStream output = activity.getContentResolver().openOutputStream(destination)) {
                    if (output == null) throw new IOException("No image output");
                    output.write(bytes);
                }
                reply(requestId, true, false, "图片已保存");
            } catch (Exception failure) { reply(requestId, false, false, "图片保存失败，请重试"); }
        });
    }

    private void reply(String requestId, boolean success, boolean cancelled, String message) {
        activity.runOnUiThread(() -> {
            if (destroyed) return;
            if (requestId.equals(activeRequest)) { activeRequest = null; pendingBytes = null; }
            if (!cancelled && !message.isEmpty()) Toast.makeText(activity, message, Toast.LENGTH_SHORT).show();
            if (!trustedPage.getAsBoolean()) return;
            try {
                JSONObject detail = new JSONObject(); detail.put("requestId", requestId); detail.put("success", success); detail.put("cancelled", cancelled); detail.put("message", message);
                web.evaluateJavascript("window.dispatchEvent(new CustomEvent('tieyou-image-saved',{detail:" + detail.toString() + "}))", null);
            } catch (Exception ignored) { }
        });
    }

    void destroy() { destroyed = true; pendingBytes = null; worker.shutdown(); }
}
