# Builds the Sadak Sense Android app (Trusted Web Activity: the installed app opens the live site full screen).
# Run in PowerShell from the repo folder, after the Render link exists:
#   powershell -ExecutionPolicy Bypass -File android\build-apk.ps1 -Url https://YOUR-APP.onrender.com
# You type the signing passwords yourself when asked (keep them in your password manager; losing the
# keystore means you can't update the app later).
param([Parameter(Mandatory = $true)][string]$Url)
$ErrorActionPreference = "Stop"
$Url = $Url.TrimEnd("/")
$hostName = ([Uri]$Url).Host
$dir = Join-Path $PSScriptRoot "build"
New-Item -ItemType Directory -Force $dir | Out-Null
$keystore = Join-Path $dir "sadak-sense.keystore"

# 1. Signing key (once). keytool asks for the passwords and your name; nothing is stored in the repo.
if (-not (Test-Path $keystore)) {
  Write-Host "Creating the signing key. Choose a password and remember it." -ForegroundColor Cyan
  keytool -genkeypair -v -keystore $keystore -alias sadaksense -keyalg RSA -keysize 2048 -validity 10000
}

# 2. App description for Bubblewrap.
$twa = [ordered]@{
  packageId = "com.sadaksense.app"; host = $hostName; name = "Sadak Sense"; launcherName = "Sadak Sense"
  display = "standalone"; orientation = "portrait"; themeColor = "#080B10"; themeColorDark = "#080B10"
  navigationColor = "#080B10"; navigationColorDark = "#080B10"; navigationDividerColor = "#080B10"; navigationDividerColorDark = "#080B10"
  backgroundColor = "#080B10"; enableNotifications = $false; startUrl = "/drive/"
  iconUrl = "$Url/drive/icon-512.png"; maskableIconUrl = "$Url/drive/icon-maskable-512.png"
  appVersionName = "1.0.0"; appVersionCode = 1; shortcuts = @(); generatorApp = "bubblewrap-cli"
  webManifestUrl = "$Url/drive/manifest.webmanifest"; fallbackType = "customtabs"; features = @{}
  alphaDependencies = @{ enabled = $false }; enableSiteSettingsShortcut = $true; isChromeOSOnly = $false; isMetaQuest = $false
  fullScopeUrl = "$Url/"; minSdkVersion = 21; fingerprints = @()
  signingKey = @{ path = $keystore; alias = "sadaksense" }; additionalTrustedOrigins = @(); retainedBundles = @()
}
$twa | ConvertTo-Json -Depth 5 | Out-File -Encoding utf8 (Join-Path $dir "twa-manifest.json")

# 3. Generate the Android project and build. First run: Bubblewrap offers to download the Android SDK (say yes).
Push-Location $dir
try {
  npx --yes @bubblewrap/cli@1.28.0 update --skipVersionUpgrade
  npx --yes @bubblewrap/cli@1.28.0 build
} finally { Pop-Location }

# 4. The fingerprint Render needs so the app opens full screen (Digital Asset Links).
$line = (keytool -list -v -keystore $keystore -alias sadaksense | Select-String "SHA256:" | Select-Object -First 1).ToString()
$sha = ($line -split "SHA256:")[-1].Trim()
Write-Host ""
Write-Host "APK: $dir\app-release-signed.apk" -ForegroundColor Green
Write-Host "In Render > Environment set:" -ForegroundColor Green
Write-Host "  ANDROID_PACKAGE = com.sadaksense.app"
Write-Host "  ANDROID_SHA256  = $sha"
Write-Host "Then copy the APK to the phone and install it (allow 'install unknown apps' for your file manager)."
