# Android 构建与更新

使用 Android SDK Platform 35、Build Tools 35.0.0 和 JDK 17 构建。

```powershell
pwsh -File android/build.ps1 -ReleaseNotes '本次更新说明'
```

构建前递增 AndroidManifest.xml 的 versionCode，并修改 versionName。构建输出在 dist/android。

- tieyou-android.apk 为首页下载的安装包。
- tieyou-android-版本号.apk 为更新使用的固定版本安装包。
- android-release.json 记录版本号、下载地址、大小、SHA-256 和更新说明。

发布时将两个 APK 上传到网站 downloads 目录，核对文件大小和 SHA-256，最后替换 android-release.json。保留已有固定版本安装包，以便正在下载的用户完成更新。更新检查使用 https://sbwsz.cn/downloads/android-release.json。

App 启动后每天最多自动检查一次，网络失败不打断组牌。在账号窗口可以手动检查。用户确认后由 Android DownloadManager 下载，下载任务在重开 App 后继续追踪。安装前校验大小和 SHA-256，然后交由系统确认安装。首次安装更新可能需要用户允许铁有安装应用。

从 0.2.2 起，页面资源独立更新。App 启动或回到前台时在后台检查（最多每十分钟一次），自动下载并校验完整资源包。当前页面继续使用原有文件，下次重新启动 App 时切换；断网、校验或下载失败时保留原版。安装包内仍有完整离线页面。升级安卓安装包时优先使用其中较新的页面，避免旧缓存覆盖新版。从 0.2.4 起，页面资源更新全程静默，不再弹出“页面更新已下载”提示；安卓安装包更新仍提供下载和安装入口。

仅发布页面改动时，无需重新编译 APK：

```powershell
node scripts/build-android-web.mjs
```

将 dist/android/tieyou-web-哈希.zip 上传至 downloads，核对大小与 SHA-256，再发布 web-release.json。资源包与网页在线版本应来自同一次验收通过的改动。完整安卓构建也会自动生成资源包及其清单，APK 中记录相同的页面构建时间。资源包要求 versionCode 至少为 7；更旧客户端需要先覆盖安装一次 0.2.2。

这是打开 App 时检查并自动下载，应用关闭期间不运行后台推送服务。安卓安装包更新与页面资源更新分别使用 android-release.json、web-release.json，发布时均先上传不可变文件，最后更新对应清单。

后续版本沿用原有签名密钥 app/.local/android/test-signing.jks。密钥仅保存在本机。覆盖安装保留应用数据。
