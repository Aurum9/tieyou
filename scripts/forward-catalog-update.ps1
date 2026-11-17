param(
    [string]$CacheDirectory,
    [string]$Python = 'python',
    [switch]$Force
)

$ErrorActionPreference = 'Stop'
$localState = Join-Path (Split-Path $PSScriptRoot) '.local'
$jobState = Join-Path $localState 'catalog-forwarder'
$key = Join-Path $localState 'ssh-deploy/edh-hk-deploy'
$knownHosts = Join-Path $localState 'edh-hk-known-hosts'
$server = 'ubuntu@43.129.215.254'
$remoteBase = '/home/ubuntu/.local/edh-atlas'
$sshArgs = @('-i', $key, '-o', 'BatchMode=yes', '-o', 'IdentitiesOnly=yes', '-o', 'ConnectTimeout=12',
    '-o', 'ServerAliveInterval=20', '-o', 'ServerAliveCountMax=3', '-o', 'StrictHostKeyChecking=yes',
    '-o', "UserKnownHostsFile=$knownHosts")
New-Item -ItemType Directory -Path $jobState -Force | Out-Null
if (!$CacheDirectory) { $CacheDirectory = Join-Path $jobState 'source-cache' }
$stamp = Join-Path $jobState 'last-success.txt'
$today = [TimeZoneInfo]::ConvertTimeBySystemTimeZoneId([DateTimeOffset]::UtcNow, 'China Standard Time').Date
if (!$Force -and (Test-Path -LiteralPath $stamp)) {
    $last = [DateTime]::ParseExact((Get-Content -LiteralPath $stamp -Raw).Trim(), 'yyyy-MM-dd', $null)
    if ($today -lt $last.AddDays(2)) { exit 0 }
}

Start-Transcript -Path (Join-Path $jobState 'last-run.log') | Out-Null
try {
    $releaseFile = Join-Path $jobState 'chinese-release.json'
    $release = ssh @sshArgs $server "curl -fsS --max-time 20 -H 'User-Agent: CommanderDesk' https://api.github.com/repos/HeliumOctahelide/magic-cards-zhs/releases/latest"
    if ($LASTEXITCODE -ne 0) { throw 'Unable to check the Chinese catalog release' }
    $release | Set-Content -Encoding utf8 -LiteralPath $releaseFile
    $arguments = @("$PSScriptRoot/refresh_catalog_sources.py", '--cache', $CacheDirectory, '--chinese-release-file', $releaseFile)
    $expected = & $Python @arguments --check | ConvertFrom-Json
    if ($LASTEXITCODE -ne 0) { throw ($expected | ConvertTo-Json -Depth 6 -Compress) }
    $command = "cd $remoteBase && python3 current/scripts/update-catalog.py --state state --node runtime/node/bin/node --status"
    $active = ssh @sshArgs $server $command | ConvertFrom-Json
    if ($LASTEXITCODE -ne 0) { throw 'Unable to read the server catalog version' }
    $needed = $false
    foreach ($source in $expected.sources.PSObject.Properties) {
        $running = $active.PSObject.Properties[$source.Name].Value
        if (!$running -or [DateTimeOffset]$source.Value.updatedAt -gt [DateTimeOffset]$running.updatedAt -or
            ([DateTimeOffset]$source.Value.updatedAt -eq [DateTimeOffset]$running.updatedAt -and
             ($source.Value.url -ne $running.url -or $source.Value.sha256 -ne $running.sha256))) {
            $needed = $true
        }
    }
    if ($needed) {
        $report = & $Python @arguments | ConvertFrom-Json
        if ($LASTEXITCODE -ne 0) { throw ($report | ConvertTo-Json -Depth 6 -Compress) }
        $files = @('download-report.json', 'scryfall-bulk.metadata.json', 'chinese-release.metadata.json')
        foreach ($item in $report.downloads) { $files += @($item.name, "$($item.name).metadata.json") }
        $archive = Join-Path $jobState 'catalog-sources.tar'
        tar.exe -cf $archive -C $CacheDirectory @files
        if ($LASTEXITCODE -ne 0) { throw 'Unable to package verified card sources' }
        $hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $archive).Hash.ToLowerInvariant()
        $remoteArchive = "$remoteBase/runtime/catalog-sources-$hash.tar"
        scp @sshArgs $archive "${server}:${remoteArchive}"
        if ($LASTEXITCODE -ne 0) { throw 'Unable to upload the catalog sources' }
        $command = "cd $remoteBase && printf '%s  %s\n' $hash $remoteArchive | sha256sum -c - && " +
            "systemd-run --user --unit=edh-catalog-upload-$($hash.Substring(0, 16)) --wait --collect --pipe " +
            "--working-directory=$remoteBase --property=Nice=10 --property=RuntimeMaxSec=25min " +
            "/usr/bin/python3 current/scripts/update-catalog.py --state state --node runtime/node/bin/node " +
            "--source-archive $remoteArchive; result=`$?; rm -f -- $remoteArchive; exit `$result"
        ssh @sshArgs $server $command
        if ($LASTEXITCODE -ne 0) { throw 'Unable to activate the uploaded catalog' }
        Remove-Item -LiteralPath $archive
    }
    Set-Content -LiteralPath $stamp -Value $today.ToString('yyyy-MM-dd')
} finally {
    Stop-Transcript | Out-Null
}
