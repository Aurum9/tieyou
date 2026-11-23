package cn.sbwsz.tieyou;

import android.app.Activity;
import android.app.AlertDialog;
import android.app.DownloadManager;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.Settings;
import android.widget.Toast;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.security.MessageDigest;
import java.util.Locale;

final class AppUpdates {
    private static final String RELEASE_URL = "https://sbwsz.cn/downloads/android-release.json";
    private static final long CHECK_INTERVAL = 24 * 60 * 60 * 1000L;
    private static final int INSTALL_PERMISSION = 3;
    private final Activity activity;
    private final SharedPreferences preferences;
    private final DownloadManager downloads;
    private boolean busy;
    private boolean destroyed;
    private long lastAttempt;
    private Uri readyApk;
    private AlertDialog prompt;

    private final BroadcastReceiver completion = new BroadcastReceiver() {
        @Override public void onReceive(Context context, Intent intent) {
            long id = intent.getLongExtra(DownloadManager.EXTRA_DOWNLOAD_ID, -1);
            if (id == preferences.getLong("downloadId", -2)) inspectDownload(true);
        }
    };

    AppUpdates(Activity activity) {
        this.activity = activity;
        preferences = activity.getSharedPreferences("app-updates", Context.MODE_PRIVATE);
        downloads = (DownloadManager) activity.getSystemService(Context.DOWNLOAD_SERVICE);
        IntentFilter filter = new IntentFilter(DownloadManager.ACTION_DOWNLOAD_COMPLETE);
        if (Build.VERSION.SDK_INT >= 33) {
            activity.registerReceiver(completion, filter, Context.RECEIVER_EXPORTED);
        } else {
            activity.registerReceiver(completion, filter);
        }
    }

    String versionName() {
        try { return activity.getPackageManager().getPackageInfo(activity.getPackageName(), 0).versionName; }
        catch (PackageManager.NameNotFoundException ignored) { return ""; }
    }

    private int versionCode() throws PackageManager.NameNotFoundException {
        return activity.getPackageManager().getPackageInfo(activity.getPackageName(), 0).versionCode;
    }

    void resume() {
        if (readyApk != null) return;
        if (preferences.getLong("downloadId", -1) != -1) inspectDownload(false);
        else check(false);
    }

    void check(boolean manual) {
        if (destroyed || busy || prompt != null && prompt.isShowing()) return;
        if (preferences.getLong("downloadId", -1) != -1) {
            inspectDownload(manual);
            return;
        }
        long now = System.currentTimeMillis();
        if (!manual && (now - preferences.getLong("lastCheck", 0) < CHECK_INTERVAL ||
                now - lastAttempt < 10 * 60 * 1000)) return;
        lastAttempt = now;
        busy = true;
        if (manual) toast("正在检查更新…");
        new Thread(() -> {
            JSONObject release = null;
            Exception failure = null;
            try {
                release = fetchRelease();
                validateRelease(release);
            } catch (Exception error) { failure = error; }
            final JSONObject result = release;
            final Exception error = failure;
            activity.runOnUiThread(() -> {
                busy = false;
                if (destroyed || activity.isFinishing()) return;
                if (error != null) {
                    if (manual) toast("检查更新失败，请稍后重试");
                    return;
                }
                preferences.edit().putLong("lastCheck", System.currentTimeMillis()).apply();
                try {
                    if (result.getInt("versionCode") <= versionCode()) {
                        if (manual) toast("已是最新版本 " + versionName());
                        return;
                    }
                    String message = result.optString("notes", "");
                    if (message.length() > 1000) message = message.substring(0, 1000);
                    message += String.format(Locale.ROOT, "\n下载大小 %.1f MB", result.getLong("size") / 1048576.0);
                    prompt = new AlertDialog.Builder(activity)
                            .setTitle("铁有 " + result.getString("versionName"))
                            .setMessage(message.trim())
                            .setNegativeButton("稍后", null)
                            .setPositiveButton("下载更新", (dialog, which) -> download(result))
                            .create();
                    prompt.setOnDismissListener(dialog -> prompt = null);
                    prompt.show();
                } catch (Exception ignored) {
                    if (manual) toast("更新信息无效，请稍后重试");
                }
            });
        }, "tieyou-update-check").start();
    }

    private JSONObject fetchRelease() throws Exception {
        HttpURLConnection connection = (HttpURLConnection) new URL(RELEASE_URL).openConnection();
        connection.setConnectTimeout(12000);
        connection.setReadTimeout(12000);
        connection.setInstanceFollowRedirects(false);
        connection.setUseCaches(false);
        connection.setRequestProperty("Accept", "application/json");
        connection.setRequestProperty("User-Agent", "Tieyou-Android/" + versionName());
        try {
            if (connection.getResponseCode() != 200) throw new IllegalStateException("Release unavailable");
            try (InputStream stream = connection.getInputStream();
                 ByteArrayOutputStream buffer = new ByteArrayOutputStream()) {
                byte[] chunk = new byte[4096];
                int count;
                while ((count = stream.read(chunk)) != -1) {
                    if (buffer.size() + count > 16384) throw new IllegalStateException("Release too large");
                    buffer.write(chunk, 0, count);
                }
                return new JSONObject(buffer.toString("UTF-8"));
            }
        } finally { connection.disconnect(); }
    }

    private void validateRelease(JSONObject release) throws Exception {
        Uri url = Uri.parse(release.getString("url"));
        if (!"https".equals(url.getScheme()) || !"sbwsz.cn".equals(url.getHost()) ||
                url.getPort() != -1 && url.getPort() != 443 || url.getQuery() != null ||
                !url.getPath().matches("/downloads/tieyou-android-[0-9.]+\\.apk") ||
                !release.getString("sha256").matches("[a-f0-9]{64}") ||
                release.getLong("size") < 1 || release.getLong("size") > 50 * 1024 * 1024 ||
                release.getInt("versionCode") < 1 || !release.getString("versionName").matches("[0-9.]{1,24}")) {
            throw new IllegalArgumentException("Invalid release");
        }
    }

    private void download(JSONObject release) {
        try {
            DownloadManager.Request request = new DownloadManager.Request(Uri.parse(release.getString("url")))
                    .setTitle("铁有 " + release.getString("versionName"))
                    .setMimeType("application/vnd.android.package-archive")
                    .setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
                    .setDestinationInExternalFilesDir(activity, Environment.DIRECTORY_DOWNLOADS,
                            "tieyou-" + release.getInt("versionCode") + "-" + System.currentTimeMillis() + ".apk");
            long id = downloads.enqueue(request);
            preferences.edit().putLong("downloadId", id)
                    .remove("downloadPromptAt")
                    .putString("sha256", release.getString("sha256"))
                    .putLong("size", release.getLong("size"))
                    .putInt("versionCode", release.getInt("versionCode")).commit();
            toast("正在下载，完成后会提示安装");
        } catch (Exception failure) { toast("无法开始下载，请稍后重试"); }
    }

    private void inspectDownload(boolean manual) {
        if (busy || destroyed) return;
        long id = preferences.getLong("downloadId", -1);
        if (id == -1) return;
        try (Cursor cursor = downloads.query(new DownloadManager.Query().setFilterById(id))) {
            if (cursor == null || !cursor.moveToFirst()) {
                forgetDownload();
                if (manual) toast("下载记录已失效，请重新检查更新");
                return;
            }
            int status = cursor.getInt(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_STATUS));
            if (status == DownloadManager.STATUS_FAILED) {
                downloads.remove(id);
                forgetDownload();
                toast("更新下载失败，请重新检查更新");
                return;
            }
            if (status != DownloadManager.STATUS_SUCCESSFUL) {
                if (manual) toast("更新正在下载，可在通知栏查看进度");
                return;
            }
            if (preferences.getInt("versionCode", 0) <= versionCode()) {
                downloads.remove(id);
                forgetDownload();
                return;
            }
            if (!manual && System.currentTimeMillis() - preferences.getLong("downloadPromptAt", 0) < CHECK_INTERVAL) return;
        } catch (Exception failure) {
            if (manual) toast("无法读取下载，请稍后重试");
            return;
        }
        busy = true;
        new Thread(() -> {
            Uri downloadedUri = null;
            boolean valid = false;
            try {
                downloadedUri = downloads.getUriForDownloadedFile(id);
                Uri uri = downloadedUri;
                if (uri == null) throw new IllegalStateException("No downloaded package");
                MessageDigest digest = MessageDigest.getInstance("SHA-256");
                long size = 0;
                try (InputStream stream = activity.getContentResolver().openInputStream(uri)) {
                    if (stream == null) throw new IllegalStateException("No package stream");
                    byte[] bytes = new byte[8192];
                    int count;
                    while ((count = stream.read(bytes)) != -1) {
                        size += count;
                        if (size > preferences.getLong("size", 0)) throw new IllegalStateException("Size mismatch");
                        digest.update(bytes, 0, count);
                    }
                }
                StringBuilder hash = new StringBuilder();
                for (byte value : digest.digest()) hash.append(String.format(Locale.ROOT, "%02x", value & 255));
                valid = size == preferences.getLong("size", 0) && hash.toString().equals(preferences.getString("sha256", ""));
            } catch (Exception ignored) { }
            final boolean verified = valid;
            final Uri uri = downloadedUri;
            activity.runOnUiThread(() -> {
                busy = false;
                if (destroyed || activity.isFinishing()) return;
                if (!verified) {
                    downloads.remove(id);
                    forgetDownload();
                    toast("安装包校验失败，请重新下载");
                    return;
                }
                readyApk = uri;
                preferences.edit().putLong("downloadPromptAt", System.currentTimeMillis()).apply();
                prompt = new AlertDialog.Builder(activity)
                        .setTitle("更新已下载")
                        .setMessage("现在安装铁有更新？")
                        .setNegativeButton("稍后", (dialog, which) -> readyApk = null)
                        .setPositiveButton("安装", (dialog, which) -> install())
                        .create();
                prompt.setOnCancelListener(dialog -> readyApk = null);
                prompt.setOnDismissListener(dialog -> prompt = null);
                prompt.show();
            });
        }, "tieyou-update-verify").start();
    }

    private void forgetDownload() {
        readyApk = null;
        preferences.edit().remove("downloadId").remove("sha256").remove("size").remove("versionCode").remove("downloadPromptAt").apply();
    }

    private void install() {
        if (readyApk == null || destroyed) return;
        try {
            if (!activity.getPackageManager().canRequestPackageInstalls()) {
                activity.startActivityForResult(new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                        Uri.parse("package:" + activity.getPackageName())), INSTALL_PERMISSION);
                return;
            }
            Intent intent = new Intent(Intent.ACTION_VIEW)
                    .setDataAndType(readyApk, "application/vnd.android.package-archive")
                    .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            activity.startActivity(intent);
            readyApk = null;
        } catch (Exception failure) {
            readyApk = null;
            toast("无法打开安装界面，可从下载完成通知打开安装包");
        }
    }

    void permissionResult(int request) {
        if (request != INSTALL_PERMISSION) return;
        if (activity.getPackageManager().canRequestPackageInstalls()) install();
        else {
            readyApk = null;
            toast("允许铁有安装应用后，可继续安装更新");
        }
    }

    void destroy() {
        destroyed = true;
        activity.unregisterReceiver(completion);
        if (prompt != null) prompt.dismiss();
    }

    private void toast(String text) { Toast.makeText(activity, text, Toast.LENGTH_SHORT).show(); }
}
