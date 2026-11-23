package cn.sbwsz.tieyou;

import android.app.Activity;
import android.content.SharedPreferences;
import android.net.Uri;
import org.json.JSONObject;
import java.io.*;
import java.net.HttpURLConnection;
import java.net.URL;
import java.security.MessageDigest;
import java.util.HashSet;
import java.util.Set;
import java.util.UUID;
import java.util.Map;
import java.util.HashMap;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;

/** Pin one complete UI bundle for the lifetime of a WebView; stage upgrades for its next launch. */
final class WebAssets {
    private static final Map<String, Integer> PINNED = new HashMap<>();
    private static final String RELEASE = "https://sbwsz.cn/downloads/web-release.json";
    private final Activity activity;
    private final File root;
    private final SharedPreferences preferences;
    private final File active;
    private final long packagedAt;
    private boolean busy, destroyed;
    private long attempted;

    WebAssets(Activity activity) {
        this.activity = activity;
        root = new File(activity.getFilesDir(), "web-updates");
        root.mkdirs();
        preferences = activity.getSharedPreferences("web-updates", 0);
        long timestamp = 0;
        try (InputStream input = activity.getAssets().open("web/web-build.json")) {
            ByteArrayOutputStream bytes = new ByteArrayOutputStream(); byte[] buffer = new byte[1024]; int count;
            while ((count = input.read(buffer)) != -1) { if (bytes.size() + count > 4096) throw new IOException("Invalid build info"); bytes.write(buffer, 0, count); }
            timestamp = new JSONObject(bytes.toString("UTF-8")).getLong("builtAt");
        } catch (Exception ignored) { }
        packagedAt = timestamp;
        String revision = preferences.getString("ready", "");
        File candidate = new File(root, revision);
        synchronized (WebAssets.class) {
            active = revision.matches("[a-f0-9]{64}") && preferences.getLong("readyBuiltAt", 0) >= packagedAt && complete(candidate) ? candidate : null;
            if (active != null) PINNED.put(revision, PINNED.containsKey(revision) ? PINNED.get(revision) + 1 : 1);
        }
    }

    InputStream open(String path) throws IOException {
        if (active == null) return activity.getAssets().open("web" + path);
        File file = new File(active, path.substring(1));
        if (!file.getCanonicalPath().startsWith(active.getCanonicalPath() + File.separator)) throw new IOException("Invalid path");
        return new FileInputStream(file);
    }

    synchronized void resume() {
        if (destroyed || busy || System.currentTimeMillis() - attempted < 10 * 60 * 1000L) return;
        attempted = System.currentTimeMillis(); busy = true;
        new Thread(() -> {
            File temporary = null;
            try {
                JSONObject release = new JSONObject(new String(fetch(RELEASE, 16384), "UTF-8"));
                String hash = release.getString("sha256"), url = release.getString("url");
                long size = release.getLong("size"); Uri uri = Uri.parse(url);
                if (release.getInt("version") != 1 || !hash.matches("[a-f0-9]{64}") || size < 1 || size > 32 * 1024 * 1024 ||
                    !"https".equals(uri.getScheme()) || !"sbwsz.cn".equals(uri.getHost()) || uri.getUserInfo() != null ||
                    uri.getPort() != -1 && uri.getPort() != 443 || uri.getQuery() != null || uri.getFragment() != null ||
                    !("/downloads/tieyou-web-" + hash + ".zip").equals(uri.getPath())) throw new IOException("Invalid web release");
                int installed = activity.getPackageManager().getPackageInfo(activity.getPackageName(), 0).versionCode;
                long builtAt = release.getLong("builtAt");
                if (builtAt <= packagedAt || builtAt < preferences.getLong("readyBuiltAt", 0) || release.getInt("minVersionCode") > installed || hash.equals(preferences.getString("ready", "")) && complete(new File(root, hash))) return;
                byte[] archive = fetch(url, 32 * 1024 * 1024);
                if (archive.length != size || !hash.equals(sha256(archive))) throw new IOException("Web archive mismatch");
                File destination = new File(root, hash);
                if (!complete(destination)) {
                    temporary = new File(root, ".pending-" + UUID.randomUUID());
                    if (!temporary.mkdirs()) throw new IOException("No staging directory");
                    unpack(archive, temporary);
                    if (!new File(temporary, "index.html").isFile() || !new File(temporary, "app.js").isFile()) throw new IOException("Incomplete web archive");
                    if (!new File(temporary, ".complete").createNewFile()) throw new IOException("No completion marker");
                    if (!temporary.renameTo(destination) && !complete(destination)) throw new IOException("Cannot activate web archive");
                }
                synchronized (WebAssets.class) {
                    if (builtAt < preferences.getLong("readyBuiltAt", 0)) return;
                    if (!preferences.edit().putString("ready", hash).putLong("readyBuiltAt", builtAt).commit()) throw new IOException("Cannot save web revision");
                    File[] older = root.listFiles();
                    if (older != null) for (File file : older) {
                        if (file.getName().matches("[a-f0-9]{64}") && !file.equals(destination) && !PINNED.containsKey(file.getName())) remove(file);
                    }
                }
            } catch (Exception ignored) {
                // Offline or failed downloads keep the current complete bundle.
            } finally {
                if (temporary != null && temporary.exists()) remove(temporary);
                synchronized (WebAssets.this) { busy = false; }
            }
        }, "tieyou-web-update").start();
    }

    synchronized void destroy() {
        if (destroyed) return;
        destroyed = true;
        synchronized (WebAssets.class) {
            if (active != null && PINNED.containsKey(active.getName())) {
                int count = PINNED.get(active.getName());
                if (count <= 1) PINNED.remove(active.getName()); else PINNED.put(active.getName(), count - 1);
            }
        }
    }
    private static boolean complete(File folder) { return new File(folder, ".complete").isFile() && new File(folder, "index.html").isFile() && new File(folder, "app.js").isFile(); }
    private static byte[] fetch(String url, int limit) throws IOException {
        HttpURLConnection connection = (HttpURLConnection) new URL(url).openConnection();
        connection.setConnectTimeout(10000); connection.setReadTimeout(15000); connection.setInstanceFollowRedirects(false); connection.setUseCaches(false);
        connection.setRequestProperty("User-Agent", "Tieyou-Web-Updater");
        try {
            if (connection.getResponseCode() != 200) throw new IOException("Web update unavailable");
            try (InputStream input = connection.getInputStream(); ByteArrayOutputStream output = new ByteArrayOutputStream()) {
                byte[] buffer = new byte[16384]; int count;
                while ((count = input.read(buffer)) != -1) { if (output.size() + count > limit) throw new IOException("Web update too large"); output.write(buffer, 0, count); }
                return output.toByteArray();
            }
        } finally { connection.disconnect(); }
    }
    private static String sha256(byte[] data) throws Exception {
        byte[] digest = MessageDigest.getInstance("SHA-256").digest(data); StringBuilder output = new StringBuilder();
        for (byte value : digest) output.append(String.format(java.util.Locale.ROOT, "%02x", value & 255));
        return output.toString();
    }
    private static void unpack(byte[] archive, File folder) throws IOException {
        long total = 0; Set<String> names = new HashSet<>();
        try (ZipInputStream zip = new ZipInputStream(new ByteArrayInputStream(archive))) {
            ZipEntry entry;
            while ((entry = zip.getNextEntry()) != null) {
                if (entry.isDirectory()) continue;
                String name = entry.getName();
                if (name.length() > 240 || !name.matches("[A-Za-z0-9_./-]+") || name.startsWith("/") || name.contains("..") || !names.add(name) || names.size() > 5000) throw new IOException("Invalid web archive path");
                File target = new File(folder, name);
                if (!target.getCanonicalPath().startsWith(folder.getCanonicalPath() + File.separator)) throw new IOException("Invalid web archive path");
                File parent = target.getParentFile(); if (!parent.isDirectory() && !parent.mkdirs()) throw new IOException("Cannot create web directory");
                try (OutputStream output = new FileOutputStream(target)) {
                    byte[] buffer = new byte[16384]; int count;
                    while ((count = zip.read(buffer)) != -1) { total += count; if (total > 64 * 1024 * 1024) throw new IOException("Web archive too large"); output.write(buffer, 0, count); }
                }
            }
        }
    }
    private static void remove(File file) {
        File[] children = file.listFiles(); if (children != null) for (File child : children) remove(child);
        file.delete();
    }
}
