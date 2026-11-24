param(
    [string]$Sdk = $env:ANDROID_HOME,
    [string]$OutDir = 'dist/android',
    [string]$ReleaseNotes = '页面资源支持后台自动更新；安装包新版可在 App 内检查、下载并安装。'
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
if (!$Sdk) { $Sdk = Join-Path $env:LOCALAPPDATA 'Android/Sdk' }
$sdkTools = Join-Path $Sdk 'build-tools/35.0.0'
$androidJar = Join-Path $Sdk 'platforms/android-35/android.jar'
if (!(Test-Path -LiteralPath $androidJar) -or !(Test-Path -LiteralPath $sdkTools)) {
    throw 'Install Android SDK Platform 35 and Build Tools 35.0.0, or pass -Sdk.'
}

$project = Split-Path $PSScriptRoot
Push-Location $project
try {
$output = $OutDir
$state = '.local/android'
$build = Join-Path $state ([Guid]::NewGuid().ToString('N'))
$webAssets = Join-Path $build 'assets/web'
$classes = Join-Path $build 'classes'
New-Item -ItemType Directory -Force -Path $output, $webAssets, "$webAssets/data", $classes | Out-Null
$platformJar = Join-Path $build 'android.jar'
Copy-Item -LiteralPath $androidJar -Destination $platformJar

function Invoke-Checked([string]$Executable, [string[]]$Arguments) {
    & $Executable @Arguments
    if ($LASTEXITCODE -ne 0) { throw "$Executable exited with code $LASTEXITCODE" }
}

$utf8 = [Text.UTF8Encoding]::new($false)
$webRoot = Join-Path $project 'web'
Get-ChildItem -LiteralPath $webRoot -File | Copy-Item -Destination $webAssets
foreach ($directory in 'assets', 'lib') {
    Copy-Item -LiteralPath (Join-Path $webRoot $directory) -Destination $webAssets -Recurse
}
foreach ($filename in 'tag-vocabulary.json', 'playtest-tokens.json', 'DATA-LICENSE.md') {
    Copy-Item -LiteralPath (Join-Path $webRoot "data/$filename") -Destination "$webAssets/data"
}
$index = (Resolve-Path (Join-Path $webAssets 'index.html')).Path
$html = [IO.File]::ReadAllText($index).Replace('<head>', '<head><script>window.tieyouAndroid = true;document.documentElement.classList.add("tieyou-android");</script>')
[IO.File]::WriteAllText($index, $html, $utf8)
Invoke-Checked 'node.exe' @('scripts/build-android-web.mjs', '--assets', $webAssets, '--out', $output)

$aapt2 = Join-Path $sdkTools 'aapt2.exe'
$resources = Join-Path $build 'resources.zip'
$unsigned = Join-Path $build 'unsigned.apk'
$aligned = Join-Path $build 'aligned.apk'
$manifest = 'android/AndroidManifest.xml'
Invoke-Checked $aapt2 @('compile', '--dir', 'android/res', '-o', $resources)
Invoke-Checked $aapt2 @('link', '-o', $unsigned, '--manifest', $manifest, '-I', $platformJar, $resources)

$javaSources = @(Get-ChildItem -LiteralPath 'android/src/cn/sbwsz/tieyou' -Filter '*.java' -File | ForEach-Object FullName)
Invoke-Checked 'javac.exe' (@('--release', '8', '-encoding', 'UTF-8', '-cp', $platformJar, '-d', $classes) + $javaSources)
$classJar = Join-Path $build 'classes.jar'
Invoke-Checked 'jar.exe' @('cf', $classJar, '-C', $classes, '.')
Invoke-Checked (Join-Path $sdkTools 'd8.bat') @('--min-api', '26', '--lib', $platformJar, '--output', $build, $classJar)
Add-Type -AssemblyName System.IO.Compression, System.IO.Compression.FileSystem
$archive = [IO.Compression.ZipFile]::Open((Resolve-Path $unsigned).Path, [IO.Compression.ZipArchiveMode]::Update)
try {
    $dex = (Resolve-Path "$build/classes.dex").Path
    [IO.Compression.ZipFileExtensions]::CreateEntryFromFile($archive, $dex, 'classes.dex') | Out-Null
    $assetsFolder = (Resolve-Path "$build/assets").Path
    # Android AssetManager uses ZIP entry names with forward slashes.
    foreach ($file in Get-ChildItem -LiteralPath $assetsFolder -Recurse -File) {
        $relative = $file.FullName.Substring($assetsFolder.Length + 1).Replace('\', '/')
        [IO.Compression.ZipFileExtensions]::CreateEntryFromFile($archive, $file.FullName, "assets/$relative") | Out-Null
    }
} finally { $archive.Dispose() }
Invoke-Checked (Join-Path $sdkTools 'zipalign.exe') @('-f', '4', $unsigned, $aligned)

# Keep the local test key so future APKs can upgrade without erasing the on-device library.
$key = Join-Path $state 'test-signing.jks'
if (!(Test-Path -LiteralPath $key)) {
    Invoke-Checked 'keytool.exe' @('-genkeypair', '-keystore', $key, '-storepass', 'android', '-keypass', 'android',
        '-alias', 'tieyou-test', '-keyalg', 'RSA', '-keysize', '2048', '-validity', '10000', '-dname', 'CN=Tieyou Android Test')
}
$apk = Join-Path $output 'tieyou-android.apk'
$apksigner = Join-Path $sdkTools 'apksigner.bat'
Invoke-Checked $apksigner @('sign', '--ks', $key, '--ks-key-alias', 'tieyou-test', '--ks-pass', 'pass:android', '--key-pass', 'pass:android',
    '--out', $apk, $aligned)
Invoke-Checked $apksigner @('verify', '--verbose', $apk)
[xml]$manifestXml = Get-Content -LiteralPath $manifest -Raw
$androidNamespace = 'http://schemas.android.com/apk/res/android'
$versionName = $manifestXml.manifest.GetAttribute('versionName', $androidNamespace)
$versionCode = [int]$manifestXml.manifest.GetAttribute('versionCode', $androidNamespace)
if ($versionName -notmatch '^[0-9.]{1,24}$') { throw 'Invalid Android version name' }
$versionedName = "tieyou-android-$versionName.apk"
Copy-Item -LiteralPath $apk -Destination (Join-Path $output $versionedName) -Force
$release = [ordered]@{
    versionCode = $versionCode
    versionName = $versionName
    url = "https://sbwsz.cn/downloads/$versionedName"
    size = (Get-Item -LiteralPath $apk).Length
    sha256 = (Get-FileHash -LiteralPath $apk -Algorithm SHA256).Hash.ToLowerInvariant()
    notes = $ReleaseNotes
}
[IO.File]::WriteAllText((Join-Path (Resolve-Path $output).Path 'android-release.json'), ($release | ConvertTo-Json) + "`n", $utf8)
Write-Output (Resolve-Path $apk).Path
} finally { Pop-Location }
