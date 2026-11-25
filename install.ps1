# HaksterAI CLI installer for Windows 10 / 11 (PowerShell 5.1 or later).
#
# Owner, 2026-11-25: "and we need avalible for windows to 11 10 etc" / "like
# make the install xheck if users have whats needed if not install" / "make sure
# its solid please". Same rule as the Linux/macOS installer: check first, install
# only what is missing, never replace something the machine already has.
#
#   Node.js  — reused when present and version 20+; otherwise the official
#              Node build is downloaded into %USERPROFILE%\.hakster\runtime and
#              checked against nodejs.org's published SHA-256 before it is used.
#   CLI      — packed and installed with npm into a per-user prefix (no admin).
#   Bun      — what our TUI runs on; installed when the machine has none.
#              Without it the CLI still runs on its built-in Ink UI.
#
# Run it:  irm __ORIGIN__/install.ps1 | iex
# Requires Windows 10 1803+ for the built-in tar.exe (used to unpack the CLI).

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$Origin = '__ORIGIN__'
$NodeVersion = if ($env:HAKSTER_NODE_VERSION) { $env:HAKSTER_NODE_VERSION } else { 'v24.22.3' }
$BunVersion = if ($env:HAKSTER_BUN_VERSION) { $env:HAKSTER_BUN_VERSION } else { '1.4.5' }
$Runtime = Join-Path $HOME '.hakster\runtime'
$NpmPrefix = Join-Path $HOME '.hakster\npm'
$Tmp = Join-Path ([IO.Path]::GetTempPath()) ("hakster-cli-install-" + [Guid]::NewGuid().ToString('n').Substring(0, 8))
New-Item -ItemType Directory -Path $Tmp -Force | Out-Null

function Say($msg) { Write-Host $msg }
function Fail($msg) { Write-Host "X $msg"; Write-Host '  Nothing was installed.'; exit 1 }

Say "HaksterAI CLI - from $Origin"

# ── Node.js ───────────────────────────────────────────────────────────────
function Get-NodeMajor {
  try {
    $v = (& node -p 'process.versions.node' 2>$null)
    if (-not $v) { return 0 }
    return [int]($v.Split('.')[0])
  } catch { return 0 }
}

$nodeOk = $false
if (Get-Command node -ErrorAction SilentlyContinue) {
  if ((Get-Command npm -ErrorAction SilentlyContinue) -and (Get-NodeMajor) -ge 20) { $nodeOk = $true }
}

if ($nodeOk) {
  Say ("OK Node " + (& node --version) + " and npm " + (& npm --version) + " are already here - using them")
} else {
  $arch = $env:PROCESSOR_ARCHITECTURE
  if ($arch -eq 'ARM64') { $tag = 'win-arm64' }
  elseif ($arch -eq 'AMD64' -or $arch -eq 'x86') { $tag = 'win-x64' }
  else { Fail ("This installer does not know how to bring Node to Windows $arch. Install Node.js 20+ from https://nodejs.org and run this again.") }

  $name = "node-$NodeVersion-$tag"
  $zip = Join-Path $Tmp "$name.zip"
  Say ".. installing Node $NodeVersion into $Runtime (one time, about 32 MB)"
  New-Item -ItemType Directory -Path $Runtime -Force | Out-Null
  try {
    Invoke-WebRequest -Uri "https://nodejs.org/dist/$NodeVersion/$name.zip" -OutFile $zip -UseBasicParsing
    Invoke-WebRequest -Uri "https://nodejs.org/dist/$NodeVersion/SHASUMS256.txt" -OutFile (Join-Path $Tmp 'SHASUMS256.txt') -UseBasicParsing
  } catch { Fail "could not download Node from nodejs.org: $($_.Exception.Message)" }

  $want = $null
  foreach ($line in Get-Content (Join-Path $Tmp 'SHASUMS256.txt')) {
    $parts = $line -split '\s+'
    if ($parts.Count -ge 2 -and $parts[1] -eq "$name.zip") { $want = $parts[0]; break }
  }
  if (-not $want) { Fail "no published checksum for $name.zip" }
  $got = (Get-FileHash -Path $zip -Algorithm SHA256).Hash.ToLower()
  if ($got -ne $want.ToLower()) { Fail 'the Node download does not match its published checksum - not using it' }
  Say 'OK checksum verified'

  try { Expand-Archive -Path $zip -DestinationPath $Runtime -Force }
  catch { Fail "could not unpack Node: $($_.Exception.Message)" }
  $nodeDir = Join-Path $Runtime $name
  if (-not (Test-Path (Join-Path $nodeDir 'node.exe'))) { Fail "Node unpacked but $nodeDir\node.exe is missing" }
  $env:Path = "$nodeDir;$env:Path"
  Say ("OK Node " + (& node --version) + " installed in $nodeDir")
}

# ── the CLI itself ────────────────────────────────────────────────────────
$tarExe = Get-Command tar.exe -ErrorAction SilentlyContinue
if (-not $tarExe) { Fail 'tar.exe is missing. It ships with Windows 10 1803+; on an older build install Node.js and run: npm install -g hakster-cli' }

Say ".. downloading the CLI from $Origin"
$cliTgz = Join-Path $Tmp 'cli.tar.gz'
try { Invoke-WebRequest -Uri "$Origin/cli/pkg.tar.gz" -OutFile $cliTgz -UseBasicParsing }
catch { Fail "could not download the CLI package: $($_.Exception.Message)" }
& $tarExe.Source -xzf $cliTgz -C $Tmp
if (-not (Test-Path (Join-Path $Tmp 'cli\package.json'))) { Fail 'could not unpack the CLI package' }

Say '.. installing the CLI (this takes a minute)'
Push-Location (Join-Path $Tmp 'cli')
try {
  $packed = (& npm pack --silent --pack-destination $Tmp . 2>$null) | Select-Object -Last 1
  if (-not $packed -or -not $packed.EndsWith('.tgz')) { Fail 'could not pack the CLI for install' }
  $pkgPath = Join-Path $Tmp $packed
  if (-not (Test-Path $pkgPath)) { Fail 'could not pack the CLI for install' }

  # A per-user prefix: no administrator rights, nothing changed system-wide.
  & npm install -g $pkgPath --prefix $NpmPrefix --no-audit --no-fund 2>$null | Out-Null
  if ($LASTEXITCODE -ne 0) { Fail 'npm could not install the CLI' }
} finally { Pop-Location }

$HaksterCmd = Join-Path $NpmPrefix 'hakster.cmd'
if (-not (Test-Path $HaksterCmd)) {
  $found = Get-ChildItem -Path $NpmPrefix -Filter 'hakster.cmd' -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($found) { $HaksterCmd = $found.FullName } else { Fail "the CLI installed but no hakster.cmd was found under $NpmPrefix" }
}

# Put it on the user's PATH once (never duplicated, never system-wide).
$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if (-not $userPath) { $userPath = '' }
$parts = @($userPath.Split(';') | Where-Object { $_ -ne '' })
if ($parts -notcontains $NpmPrefix) {
  $newPath = (@($parts) + $NpmPrefix) -join ';'
  [Environment]::SetEnvironmentVariable('Path', $newPath, 'User')
  Say "OK added $NpmPrefix to your user PATH (new terminals pick it up)"
} else {
  Say "OK $NpmPrefix is already on your user PATH"
}
$env:Path = "$NpmPrefix;$env:Path"

# ── Bun (the full TUI) ────────────────────────────────────────────────────
$bunDir = Join-Path $Runtime 'bun'
$bunExe = Join-Path $bunDir 'node_modules\bun\bin\bun.exe'
if (Get-Command bun -ErrorAction SilentlyContinue) {
  Say 'OK Bun is already here - using it'
} elseif (Test-Path $bunExe) {
  Say "OK Bun already installed in $bunDir - using it"
} else {
  Say '.. installing Bun for the full TUI (one time)'
  & npm install --prefix $bunDir --omit=dev --no-audit --no-fund "bun@$BunVersion" 2>$null | Out-Null
  if ($LASTEXITCODE -eq 0 -and (Test-Path $bunExe)) { Say "OK Bun installed in $bunDir" }
  else { Say '! Bun could not be installed - the CLI still runs with its built-in Ink UI' }
}

# Point the CLI at the server it came from.
try { & $HaksterCmd config set server $Origin 2>$null | Out-Null } catch { }

$version = ''
try { $version = (& $HaksterCmd --version 2>$null | Select-Object -First 1) } catch { }
Say ''
if ($version) { Say "Installed: HaksterAI CLI $version" } else { Say 'Installed: HaksterAI CLI (version did not answer - check `hakster --version`)' }
Say ''
Say 'Next (open a new terminal so PATH applies):'
Say '  1) sign in - a magic link opens in your browser, press Allow:'
Say '       hakster login'
Say '  2) start your agent, or run Claude Code on this plan:'
Say '       hakster            # our own terminal agent'
Say '       hakster claude     # Claude Code on this plan (sets it up once if you have none)'
Say ''
Say '  Check any time:  hakster whoami'
Say "  No browser handy?  `$env:HAKSTER_API_KEY='<key from $Origin/dashboard/>'"

Set-Location $env:USERPROFILE
Remove-Item -Path $Tmp -Recurse -Force -ErrorAction SilentlyContinue
