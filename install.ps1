#Requires -Version 5.1
# HaksterAI CLI installer for Windows 10 / 11 (PowerShell 5.1 or later).
#
# Owner, 2026-11-25: "and we need avalible for windows to 11 10 etc" / "like
# make the install xcheck if users have whats needed if not install" / "make
# sure its solid please". Same rule as the Linux/macOS installer: check first,
# install only what is missing, never replace something the machine already has.
#
#   Node.js  — reused when present and version 20+; otherwise the official
#              Node build is downloaded into %USERPROFILE%\.hakster\runtime and
#              checked against nodejs.org's published SHA-256 before it is used.
#   CLI      — packed and installed with npm into a per-user prefix (no admin).
#   Bun      — what our TUI runs on; installed when the machine has none.
#              Without it the CLI still runs on its built-in Ink UI.
#
# Before any of that, one read-only pass prints what this machine already has —
# node, bun, Claude Code and an older CLI (owner, 2026-11-26: check what a machine
# is missing before installing, so every install is fast) — so the install only
# brings the gaps and nothing is fetched twice.
#
# Run it:  irm __ORIGIN__/install.ps1 | iex
# Requires Windows 10 1803+ for the built-in tar.exe (used to unpack the CLI).
#
# The whole body runs in its own scope: a failure throws an error you can read
# instead of closing the window you ran this from, and no preference variable
# of yours is left changed.

& {
  $ErrorActionPreference = 'Stop'
  $ProgressPreference = 'SilentlyContinue'
  try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 } catch { }

  $Origin = '__ORIGIN__'
  $NodeVersion = if ($env:HAKSTER_NODE_VERSION) { $env:HAKSTER_NODE_VERSION } else { 'v24.22.3' }
  $BunVersion = if ($env:HAKSTER_BUN_VERSION) { $env:HAKSTER_BUN_VERSION } else { '1.4.5' }
  # $Runtime / $NpmPrefix are set by the install-root block below, which decides
  # the folder once and prints it.
  $Tmp = Join-Path ([IO.Path]::GetTempPath()) ("hakster-cli-install-" + [Guid]::NewGuid().ToString('n').Substring(0, 8))

  function Say($msg) { Write-Host $msg }
  function Fail($msg) {
    Write-Host "X $msg"
    Write-Host '  Nothing was installed.'
    throw $msg
  }

  # ── where our files go ─────────────────────────────────────────────────────
  # Owner, 2026-11-26: "need to make sure file on windows go to c drive". Every
  # file this install writes lives under ONE folder on the system drive. $HOME is
  # %USERPROFILE%, normally C:\Users\<you> — but a redirected profile, or a
  # PowerShell whose HOME was pointed elsewhere, can resolve onto another drive,
  # and then the install lands where the operator will never look. So the answer
  # is resolved once, here, printed, and handed to the CLI as HAKSTER_HOME so both
  # sides agree (§10, §13, §50.1):
  #   HAKSTER_HOME (explicit) -> %USERPROFILE% -> $HOME -> <SystemDrive>\Users\<user>
  # A home that already carries `.hakster` is kept exactly where it is — an
  # existing install is never moved or split by an installer (§49).
  function Get-SystemDrive { if ($env:SystemDrive) { return $env:SystemDrive.TrimEnd('\') } ; return 'C:' }
  function Get-DriveOf([string]$p) { if ($p -match '^(?<d>[A-Za-z]):') { return $Matches['d'].ToUpper() + ':' } ; return '' }
  $sysDrive = Get-SystemDrive
  $userName = if ($env:USERNAME) { $env:USERNAME } else { 'user' }
  $sysProfile = Join-Path ($sysDrive + '\') ('Users\' + $userName)
  $InstallHome = ''
  if ($env:HAKSTER_HOME) { $InstallHome = [string]$env:HAKSTER_HOME }
  elseif ($env:USERPROFILE) { $InstallHome = [string]$env:USERPROFILE }
  elseif ($HOME) { $InstallHome = [string]$HOME }
  if (-not $InstallHome -or -not [IO.Path]::IsPathRooted($InstallHome)) { $InstallHome = $sysProfile }
  $InstallHome = [IO.Path]::GetFullPath($InstallHome).TrimEnd('\')
  if ((Get-DriveOf $InstallHome) -ne $sysDrive) {
    if (Test-Path (Join-Path $InstallHome '.hakster')) {
      Say "! our files are on $((Get-DriveOf $InstallHome)) ($InstallHome) - an existing install is there"
      Say '  it is kept exactly where it is; to move it to the system drive, set HAKSTER_HOME first'
    } else {
      Say "! $InstallHome is not on $sysDrive - installing to $sysProfile instead"
      $InstallHome = $sysProfile
    }
  }
  $HaksterHome = Join-Path $InstallHome '.hakster'
  $Runtime = Join-Path $HaksterHome 'runtime'
  $NpmPrefix = Join-Path $HaksterHome 'npm'
  # The CLI resolves its own files the same way (cli/src/home-dir.js reads this
  # first), so an install and every later run look at the same folder.
  $env:HAKSTER_HOME = $InstallHome
  try {
    if ([Environment]::GetEnvironmentVariable('HAKSTER_HOME', 'User') -ne $InstallHome) {
      [Environment]::SetEnvironmentVariable('HAKSTER_HOME', $InstallHome, 'User')
    }
  } catch { }
  Say "  files: $HaksterHome  (drive $(Get-DriveOf $HaksterHome))"

  # Mirrors cli/src/runtime-paths.js findBun(): the machine's own Bun wins, then
  # the one this installer brings. A fresh Bun install is usually missing from the
  # PATH of the session the CLI is later started from, so the well-known Windows
  # locations are checked directly — without that, an install says "no Bun" on a
  # machine that has one and the operator is sent to the dashboard-less Ink UI
  # (Surface Pro, 2026-11-26). Read-only: this never installs or edits anything.
  function Bun-Candidates {
    $out = @()
    $onPath = Get-Command bun -ErrorAction SilentlyContinue
    if ($onPath -and $onPath.Source) { $out += [string]$onPath.Source }
    $dirs = @(
      (Join-Path $Runtime 'bun\node_modules\bun\bin'),
      (Join-Path $Runtime 'bun\node_modules\.bin'),
      (Join-Path $HOME '.bun\bin'),
      (Join-Path $HOME 'scoop\shims')
    )
    if ($env:LOCALAPPDATA) { $dirs += (Join-Path $env:LOCALAPPDATA 'Programs\bun') }
    if ($env:APPDATA) { $dirs += (Join-Path $env:APPDATA 'npm') }
    if ($env:ProgramFiles) { $dirs += (Join-Path $env:ProgramFiles 'Bun') }
    foreach ($d in $dirs) {
      foreach ($n in @('bun.exe', 'bun.cmd', 'bun.bat')) {
        $full = Join-Path $d $n
        if (Test-Path $full) { $out += $full }
      }
    }
    return $out
  }
  function Find-Bun {
    $all = @(Bun-Candidates)
    if ($all.Count -gt 0) { return [string]$all[0] }
    return ''
  }

  # A Bun that answers is not automatically a Bun the dashboard can use: the
  # renderer (@opentui/core 0.9.x) declares bun >= 1.3.14, and an older one loads
  # the bundle and then dies inside the native library. This used to print
  # "Bun is already here" for ANY version, so a machine with an early Bun on PATH
  # kept the input-only Ink screen after a successful install while every step
  # reported success (Surface Pro, 2026-11-26). Measured here, never assumed — and
  # an unusable one never shadows the supported Bun this installer brings (the
  # launcher measures every candidate the same way).
  #
  # Windows on ARM is the documented exception: Bun 1.3 has no FFI there, and the
  # dashboard's renderer is loaded through bun:ffi — so an arm64 machine needs
  # Bun 1.4.0+. A flat 1.3.14 floor accepted an old Bun on an arm64 Surface Pro,
  # every line reported success, and the dashboard died at its first native call
  # (owner, 2026-11-26). The architecture is measured ONCE here and reused by the
  # renderer block below, so the floor and the package can never disagree.
  $IsWinArm64 = $false
  try {
    if ([System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture -eq 'Arm64') { $IsWinArm64 = $true }
  } catch {
    if ("$env:PROCESSOR_ARCHITECTURE" -match 'ARM64') { $IsWinArm64 = $true }
  }
  $MinBun = if ($IsWinArm64) { @(1, 4, 0) } else { @(1, 3, 14) }
  function Get-BunVersion([string]$exe) {
    if (-not $exe) { return $null }
    try {
      $raw = & $exe --version 2>$null | Select-Object -First 1
      if ("$raw" -match '(\d+)\.(\d+)\.(\d+)') {
        return @([int]$Matches[1], [int]$Matches[2], [int]$Matches[3])
      }
    } catch { }
    return $null
  }
  function Test-BunUsable($v) {
    if (-not $v) { return $false }
    for ($i = 0; $i -lt $MinBun.Count; $i++) {
      if ($v[$i] -ne $MinBun[$i]) { return ($v[$i] -gt $MinBun[$i]) }
    }
    return $true
  }
  function Format-BunVersion($v) { if ($v) { return ($v -join '.') } ; return 'an unknown version' }

  # The first Bun that can actually run the dashboard, plus what was refused.
  # The launcher measures every candidate the same way
  # (cli/src/runtime-paths.js findSupportedBun), so this reports the answer the
  # CLI itself will take — an old PATH Bun can never make the installer claim
  # the machine is ready when the dashboard would be skipped.
  function Find-UsableBun {
    $skipped = @()
    foreach ($cand in @(Bun-Candidates)) {
      $v = Get-BunVersion $cand
      if (Test-BunUsable $v) {
        return [pscustomobject]@{ Path = [string]$cand; Version = $v; Skipped = $skipped }
      }
      if ($v) { $skipped += ("$cand ($($v -join '.'))") }
    }
    return [pscustomobject]@{ Path = ''; Version = $null; Skipped = $skipped }
  }

  # npm on Windows ships as several shims (npm, npm.cmd, npm.ps1), and a name
  # that Get-Command can find is no proof it can be started: a bare `npm`
  # resolves to npm.ps1 first, which a default execution policy refuses, and an
  # extensionless shim (nvm-for-windows, scoop, Git for Windows) cannot be
  # executed by PowerShell at all. Either way the line printed is
  #   The term '...npm...' is not recognized as the name of a cmdlet
  # exactly one line after node reported OK, which reads like a Node problem and
  # is not (Surface Pro, 2026-11-26). So every candidate is PROVEN by running
  # it, and npm's own JS entry started by node.exe is the fallback that needs no
  # shim, no PATHEXT and no execution policy at all.
  function Test-NpmRuns($cand) {
    if (-not $cand -or -not $cand.exe) { return $false }
    $prev = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
      $probe = @($cand.pre) + @('--version')
      $v = (& $cand.exe @probe 2>$null | Select-Object -Last 1)
      if ($v -and ("$v" -match '^\d+\.\d+\.')) { return $true }
      return $false
    } catch { return $false } finally { $ErrorActionPreference = $prev }
  }

  function Get-NpmCommand {
    $nodeExe = ''
    $nodeCmd = Get-Command node -ErrorAction SilentlyContinue
    if ($nodeCmd -and $nodeCmd.Source) { $nodeExe = [string]$nodeCmd.Source }
    $cands = @()
    foreach ($n in @('npm.cmd', 'npm.exe')) {
      $c = Get-Command $n -ErrorAction SilentlyContinue
      if ($c -and $c.Source) { $cands += @{ exe = [string]$c.Source; pre = @(); label = [string]$c.Source } }
    }
    # npm's own JS entry beside node.exe: no shim, no PATHEXT, no policy.
    if ($nodeExe) {
      $npmCli = Join-Path (Split-Path $nodeExe -Parent) 'node_modules\npm\bin\npm-cli.js'
      if (Test-Path $npmCli) { $cands += @{ exe = $nodeExe; pre = @($npmCli); label = "node $npmCli" } }
    }
    # cmd.exe resolves npm.cmd through PATHEXT and ignores the execution policy.
    if ($env:ComSpec) { $cands += @{ exe = [string]$env:ComSpec; pre = @('/d', '/c', 'npm'); label = 'cmd /c npm' } }
    foreach ($cand in $cands) {
      if (Test-NpmRuns $cand) { return $cand }
    }
    return $null
  }

  New-Item -ItemType Directory -Path $Tmp -Force | Out-Null
  Say "HaksterAI CLI - from $Origin"

  function Get-NodeMajor {
    try {
      $v = (& node -p 'process.versions.node' 2>$null)
      if (-not $v) { return 0 }
      return [int]($v.Split('.')[0])
    } catch { return 0 }
  }

  # One resolution for the whole script: $npmExe is a command that actually
  # answered --version, or it is empty (and the install says so instead of
  # printing a cmdlet error and pretending npm failed on its own).
  $npm = Get-NpmCommand
  $npmExe = ''
  $npmPre = @()
  $npmLabel = 'none found'
  if ($npm) {
    $npmExe = [string]$npm.exe
    $npmPre = @($npm.pre)
    $npmLabel = [string]$npm.label
  }

  # ── what this machine already has ───────────────────────────────────────
  # Owner, 2026-11-26: check what a machine is missing before installing, so every
  # install is fast. One read-only pass before anything is fetched, so the steps
  # below bring only the parts that are missing. Nothing here is downloaded,
  # started or changed; every line is a lookup.
  Say ''
  Say 'What this machine already has - only the missing parts are installed:'
  if (Get-Command node -ErrorAction SilentlyContinue) {
    $nodeVer = ''
    try { $nodeVer = (& node --version 2>$null) } catch { }
    if ((Get-NodeMajor) -ge 20 -and $npmExe) {
      Say ("  OK node " + $nodeVer + " and npm (" + $npmLabel + ") - used as they are")
    } elseif ((Get-NodeMajor) -ge 20) {
      Say ("  X  node " + $nodeVer + " is here but no npm on this machine could be started - a Node 20+ runtime comes with this install")
    } else {
      Say ("  X  node " + $nodeVer + " is older than 20 - a Node 20+ runtime comes with this install")
    }
  } else {
    Say '  X  node - a Node 20+ runtime comes with this install (one time, about 32 MB)'
  }
  $bunPick = Find-UsableBun
  if ($bunPick.Path) {
    Say ("  OK bun " + (Format-BunVersion $bunPick.Version) + " ($($bunPick.Path)) - our TUI runs on it")
  } elseif ($bunPick.Skipped.Count -gt 0) {
    Say ("  !  bun " + $bunPick.Skipped[0] + " is older than the dashboard's " + ($MinBun -join '.') + " - " + $BunVersion + " comes with this install")
  } else {
    Say '  X  bun - installed below; without it the CLI uses its built-in Ink UI'
  }
  # Same rule as cli/src/claude-code-provision.js: the user's own copy on PATH
  # always wins, then our private prefix under ~/.hakster/claude-code.
  $claudeFound = ''
  $claudeCmd = Get-Command claude -ErrorAction SilentlyContinue
  if ($claudeCmd) { $claudeFound = [string]$claudeCmd.Source }
  if (-not $claudeFound) {
    foreach ($c in @(
        (Join-Path $HOME '.hakster\claude-code\node_modules\.bin\claude.cmd'),
        (Join-Path $HOME '.hakster\claude-code\node_modules\.bin\claude.exe'),
        (Join-Path $HOME '.hakster\claude-code\node_modules\@anthropic-ai\claude-code\bin\claude.exe'))) {
      if (Test-Path $c) { $claudeFound = $c; break }
    }
  }
  if ($claudeFound) {
    Say "  OK claude code at $claudeFound - your own copy is used, never moved"
  } else {
    Say "  -  claude code - not installed; 'hakster claude' sets it up once, on a paid plan"
    Say '     (nothing is downloaded now: free plans never pay for ~400 MB they cannot use)'
  }
  if (Get-Command hakster -ErrorAction SilentlyContinue) {
    Say '  -  hakster CLI - already on PATH; this install puts the published package in place of it'
  } else {
    Say '  X  hakster CLI - installed below'
  }
  Say ''

  # ── Node.js ─────────────────────────────────────────────────────────────
  # $npmExe was resolved by Get-NpmCommand above, so it is a command that ran.
  $nodeOk = $false
  if ($npmExe -and (Get-Command node -ErrorAction SilentlyContinue) -and (Get-NodeMajor) -ge 20) { $nodeOk = $true }

  if ($nodeOk) {
    $npmVer = ''
    try { $npmVer = (& $npmExe @($npmPre + @('--version')) 2>$null | Select-Object -Last 1) } catch { }
    Say ("OK Node " + (& node --version) + " and npm " + $npmVer + " are already here - using them (" + $npmLabel + ")")
  } else {
    $arch = $env:PROCESSOR_ARCHITECTURE
    if ($arch -eq 'ARM64') { $tag = 'win-arm64' }
    elseif ($arch -eq 'AMD64' -or $arch -eq 'x86') { $tag = 'win-x64' }
    else { Fail "This installer does not know how to bring Node to Windows $arch. Install Node.js 20+ from https://nodejs.org and run this again." }

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

  if (-not $npmExe) {
    $npm = Get-NpmCommand
    if ($npm) {
      $npmExe = [string]$npm.exe
      $npmPre = @($npm.pre)
      $npmLabel = [string]$npm.label
    }
  }
  if (-not $npmExe) {
    Fail ('no npm on this machine could be started - tried npm.cmd, npm.exe, node''s own npm-cli.js and cmd /c npm. Install Node.js 20+ from https://nodejs.org (it ships npm.cmd) and run this again.')
  }
  Say ("  npm: " + $npmLabel)

  # ── the CLI itself ──────────────────────────────────────────────────────
  $tarExe = Get-Command tar.exe -ErrorAction SilentlyContinue
  if (-not $tarExe) { Fail 'tar.exe is missing. It ships with Windows 10 1803+; on an older build install Node.js and run: npm install -g hakster-cli' }

  # ── what the server says the newest build is ────────────────────────────
  # Owner, 2026-11-26: "all cli any user etc install need to get latest updates".
  # /cli/latest.json advertises the version and the SHA-256 of ui-fb.mjs; the
  # package is checked against it (§39.3), so a cached copy cannot install an
  # older build. Best effort: with no endpoint the install goes ahead and says so.
  $latestVersion = ''
  $latestBundle = ''
  try {
    $latest = Invoke-RestMethod -Uri "$Origin/cli/latest.json" -UseBasicParsing -TimeoutSec 15
    if ($latest) {
      $latestVersion = [string]$latest.version
      $latestBundle = [string]$latest.bundleSha256
    }
    if ($latestVersion) { Say "OK latest published build is v$latestVersion" }
  } catch { }

  Say ".. downloading the CLI from $Origin"
  $cliTgz = Join-Path $Tmp 'cli.tar.gz'
  try { Invoke-WebRequest -Uri "$Origin/cli/pkg.tar.gz" -OutFile $cliTgz -UseBasicParsing }
  catch { Fail "could not download the CLI package: $($_.Exception.Message)" }
  & $tarExe.Source -xzf $cliTgz -C $Tmp
  $cliDir = Join-Path $Tmp 'cli'
  if (-not (Test-Path (Join-Path $cliDir 'package.json'))) { Fail 'could not unpack the CLI package' }

  if ($latestBundle -and (Test-Path (Join-Path $cliDir 'ui-fb.mjs'))) {
    $gotBundle = (Get-FileHash -Algorithm SHA256 -Path (Join-Path $cliDir 'ui-fb.mjs')).Hash.ToLower()
    if ($gotBundle -ne $latestBundle.ToLower()) {
      Say '.. the copy served did not match the advertised build - asking once more past the cache'
      $retry = Join-Path $Tmp 'cli-fresh.tar.gz'
      $freshDir = Join-Path $Tmp 'cli-fresh'
      try {
        Invoke-WebRequest -Uri "$Origin/cli/pkg.tar.gz?t=$([DateTimeOffset]::UtcNow.ToUnixTimeSeconds())" -OutFile $retry -UseBasicParsing
        New-Item -ItemType Directory -Path $freshDir -Force | Out-Null
        & $tarExe.Source -xzf $retry -C $freshDir
        if (Test-Path (Join-Path $freshDir 'cli\ui-fb.mjs')) {
          $gotFresh = (Get-FileHash -Algorithm SHA256 -Path (Join-Path $freshDir 'cli\ui-fb.mjs')).Hash.ToLower()
          if ($gotFresh -eq $latestBundle.ToLower()) { $cliDir = Join-Path $freshDir 'cli' }
        }
      } catch { }
      if ((Get-FileHash -Algorithm SHA256 -Path (Join-Path $cliDir 'ui-fb.mjs')).Hash.ToLower() -eq $latestBundle.ToLower()) {
        Say 'OK the package matches the published build (sha256 verified)'
      } else {
        Say '! the package served does not match the published bundle hash - installing the copy that arrived; re-run this installer later to pick up the newest build'
      }
    } else {
      Say 'OK the package matches the published build (sha256 verified)'
    }
  } else {
    Say '.. the server did not advertise a build to verify against - installing the package as served'
  }

  Say '.. installing the CLI (this takes a minute)'
  # npm writes the reason it failed to stderr, and this script used to discard it
  # (2>$null) - so a failed Windows install said only "npm error" with nothing to
  # act on (Surface Pro, 2026-11-26). Every npm step below is kept in one log, and
  # a failure prints npm's own last lines plus the npm that produced them. The
  # error preference is lowered around these calls: with 'Stop', merging a native
  # command's stderr (2>&1) throws NativeCommandError on an ordinary npm warning.
  $npmLog = Join-Path $Tmp 'npm-install.log'
  function Invoke-Npm([string[]]$NpmArgs) {
    if (-not $npmExe) {
      Say ("! npm could not be started (" + $npmLabel + ")")
      return 1
    }
    $prevEap = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
      # Reset first. A native command that never starts leaves $LASTEXITCODE
      # untouched, so a stale 0 used to report a failed npm as a success - the
      # reason the Surface Pro install (2026-11-26) got past npm and then died
      # on a missing hakster.cmd.
      $global:LASTEXITCODE = $null
      $arr = @($npmPre) + @($NpmArgs)
      & $npmExe @arr 2>&1 | Out-File -FilePath $npmLog -Append -Encoding utf8
      if ($null -eq $LASTEXITCODE) {
        Say ("! npm could not be started (" + $npmExe + ")")
        return 1
      }
      return $LASTEXITCODE
    } catch {
      Say ("! npm could not be started (" + $npmExe + "): " + $_.Exception.Message)
      return 1
    } finally { $ErrorActionPreference = $prevEap }
  }
  function Show-NpmFailure($exitCode) {
    Say ("! npm exited $exitCode")
    try { Say ('  npm ' + ((& $npmExe @($npmPre + @('--version')) 2>$null) | Select-Object -Last 1) + ' via ' + $npmLabel) } catch { Say ('  npm via ' + $npmLabel) }
    try { Say ('  node ' + ((& node --version 2>$null) | Select-Object -Last 1)) } catch { }
    Say '  the last lines npm printed:'
    if (Test-Path $npmLog) {
      Get-Content $npmLog -Tail 14 -ErrorAction SilentlyContinue | ForEach-Object { Say ("    " + $_) }
    } else {
      Say '    (npm printed nothing this script could capture)'
    }
  }

  Push-Location $cliDir
  try {
    $prevEap = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
      $global:LASTEXITCODE = $null
      $packArr = @($npmPre) + @('pack', '--silent', '--pack-destination', $Tmp, '.')
      $packed = (& $npmExe @packArr 2>$null) | Select-Object -Last 1
    } catch { $packed = '' } finally { $ErrorActionPreference = $prevEap }
    if (-not $packed -or -not $packed.EndsWith('.tgz')) { Fail 'could not pack the CLI for install' }
    $pkgPath = Join-Path $Tmp $packed
    if (-not (Test-Path $pkgPath)) { Fail 'could not pack the CLI for install' }

    # Pack first, install the tarball: a directory install is a link back into
    # the temp folder, which the cleanup would then delete.
    $installCode = Invoke-Npm @('install', '-g', $pkgPath, '--prefix', $NpmPrefix, '--no-audit', '--no-fund')
    if ($installCode -ne 0 -or -not (Test-Path (Join-Path $NpmPrefix 'hakster.cmd'))) {
      # A prefix left half-written or locked by an earlier attempt is the usual
      # Windows cause; --force rewrites it instead of refusing.
      Say '.. npm did not finish into the prefix - trying once more with --force'
      $installCode = Invoke-Npm @('install', '-g', $pkgPath, '--prefix', $NpmPrefix, '--no-audit', '--no-fund', '--force')
    }
    if ($installCode -ne 0 -or -not (Test-Path (Join-Path $NpmPrefix 'hakster.cmd'))) {
      # Windows' global shim step is the fragile part, not the app itself: a plain
      # install beside the prefix succeeds where the shim step refuses, so the CLI
      # goes there and the two launchers are written here. Verified layout: the
      # app in node_modules\hakster-cli with its dependencies hoisted beside it.
      Say '.. using the plain install path (no npm global shim), then writing the launcher'
      $installCode = Invoke-Npm @('install', '--prefix', $NpmPrefix, '--no-audit', '--no-fund', '--no-save', $pkgPath)
      $appDir = Join-Path $NpmPrefix 'node_modules\hakster-cli'
      $depsOk = (Test-Path (Join-Path $NpmPrefix 'node_modules\commander\package.json')) -or (Test-Path (Join-Path $appDir 'node_modules\commander\package.json'))
      if ((Test-Path (Join-Path $appDir 'index.js')) -and $depsOk) {
        $cmdShim = Join-Path $NpmPrefix 'hakster.cmd'
        $cmdLines = @(
          '@ECHO off',
          'SETLOCAL',
          'node "%~dp0node_modules\hakster-cli\index.js" %*'
        )
        Set-Content -Path $cmdShim -Value $cmdLines -Encoding ASCII
        $psShim = Join-Path $NpmPrefix 'hakster.ps1'
        $psLines = @(
          '#!/usr/bin/env pwsh',
          '$basedir = Split-Path $MyInvocation.MyCommand.Definition -Parent',
          '& node "$basedir\node_modules\hakster-cli\index.js" @args',
          'exit $LASTEXITCODE'
        )
        Set-Content -Path $psShim -Value $psLines -Encoding ASCII
        $installCode = 0
        Say ("OK the CLI is installed from the plain path (" + $cmdShim + ")")
      }
    }
    if ($installCode -ne 0 -or -not (Test-Path (Join-Path $NpmPrefix 'hakster.cmd'))) {
      Show-NpmFailure $installCode
      Fail 'npm could not install the CLI'
    }
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
    try {
      [Environment]::SetEnvironmentVariable('Path', $newPath, 'User')
      Say "OK added $NpmPrefix to your user PATH (new terminals pick it up)"
    } catch {
      Say "! could not update your user PATH automatically - add this folder to PATH yourself:"
      Say "    $NpmPrefix"
    }
  } else {
    Say "OK $NpmPrefix is already on your user PATH"
  }
  $env:Path = "$NpmPrefix;$env:Path"

  # ── OpenTUI's native renderer for this machine ──────────────────────────
  # The dashboard draws through @opentui/core, which loads its renderer from a
  # per-OS/CPU package npm publishes as an OPTIONAL dependency. A prefix install
  # or an npm config that skips optional packages leaves the dashboard dying the
  # instant it opens, with nothing useful on screen (Surface Pro, 2026-11-26).
  # The name comes from the machine's real architecture, never a guess.
  #
  # Present is not the same as usable: the renderer must carry the SAME version
  # as the @opentui/core that loads it. A copy updated without its renderer (core
  # 0.9.9 beside a 0.3.4 stub) loads a native library the core cannot use, so the
  # dashboard dies at the first frame — the Surface Pro's "input bar, no panels"
  # (owner, 2026-11-26). This block compares versions and repairs a mismatch
  # instead of reporting presence as success (§10, §13, §50.1).
  # Measured once, at the Bun floor above: the same answer decides both the
  # renderer package and the Bun version that must carry it.
  $otArch = if ($IsWinArm64) { 'arm64' } else { 'x64' }
  $otName = "@opentui/core-win32-$otArch"
  $otAppDir = Join-Path $NpmPrefix 'node_modules\hakster-cli'
  $otHere = @(
    (Join-Path $otAppDir ("node_modules\@opentui\core-win32-" + $otArch)),
    (Join-Path $NpmPrefix ("node_modules\@opentui\core-win32-" + $otArch))
  )
  function Get-PkgVersion([string]$Dir) {
    $f = Join-Path $Dir 'package.json'
    if (-not (Test-Path $f)) { return '' }
    try { return [string]((Get-Content $f -Raw | ConvertFrom-Json).version) } catch { return '' }
  }
  $otCore = Join-Path $NpmPrefix 'node_modules\@opentui\core\package.json'
  if (-not (Test-Path $otCore)) { $otCore = Join-Path $otAppDir 'node_modules\@opentui\core\package.json' }
  $otVer = ''
  if (Test-Path $otCore) {
    try { $otVer = [string]((Get-Content $otCore -Raw | ConvertFrom-Json).version) } catch { $otVer = '' }
  }
  # A renderer is usable when its version EQUALS the core's. Every location is
  # scanned and only a real match counts, so a stale stub left at one place can
  # never mask a correct package at the other — the half-updated copy that made
  # the dashboard die at the first frame (Surface Pro, 2026-11-26).
  function Get-OtState {
    $found = @()
    foreach ($p in $otHere) { $v = Get-PkgVersion $p; if ($v) { $found = @($found) + $v } }
    $have = ''
    if ($found.Count -gt 0) { $have = [string]$found[0] }
    $match = $false
    if ($otVer) { foreach ($v in $found) { if ($v -eq $otVer) { $match = $true } } }
    elseif ($have) { $match = $true }
    return @{ have = $have; match = $match }
  }
  $otState = Get-OtState
  if ($otState.match) {
    Say "OK the dashboard renderer for this machine is installed ($otName $($otState.have))"
  } else {
    if ($otState.have -and $otVer) {
      Say ".. the dashboard renderer is $($otState.have) but @opentui/core is $otVer - it would not load, so it is replaced"
    }
    if ($otVer) { $otSpec = "$otName@$otVer" } else { $otSpec = $otName }
    Say ".. installing the dashboard renderer for this machine ($otSpec)"
    # Installed into the CLI's own directory: that is where it resolves from, and
    # it is exactly what the launcher prints as the fix (`cd <app> ; npm install
    # ...`). A `npm install -g` can land in a prefix this copy is not read from
    # (cli/index.js nativeFix, 2026-11-26), and a prefix-level install on Windows
    # can reify a tree the app does not resolve through.
    if (Test-Path (Join-Path $otAppDir 'package.json')) {
      $null = Invoke-Npm @('install', '--prefix', $otAppDir, '--no-audit', '--no-fund', '--no-save', '--no-package-lock', $otSpec)
    }
    $otState = Get-OtState
    if (-not $otState.match) {
      $null = Invoke-Npm @('install', '--prefix', $NpmPrefix, '--no-audit', '--no-fund', '--no-save', $otSpec)
      $otState = Get-OtState
    }
    if ($otState.match) {
      Say "OK dashboard renderer installed ($otName $($otState.have))"
    } else {
      Say '! the dashboard renderer could not be installed - the CLI still runs, with its built-in Ink UI.'
      Say '  To get the full dashboard, run this once and start the CLI again:'
      Say ("    cd `"" + $otAppDir + "`" ; npm install --no-save --no-package-lock " + $otSpec)
    }
  }
  # The renderer step must never cost the install itself: if a reify removed the
  # app, it is put back from the package that was just packed (§49.1, §50.5).
  if (-not (Test-Path (Join-Path $otAppDir 'index.js'))) {
    Say '.. the CLI app went missing during the renderer step - restoring it'
    $null = Invoke-Npm @('install', '-g', $pkgPath, '--prefix', $NpmPrefix, '--no-audit', '--no-fund')
    if (-not (Test-Path (Join-Path $otAppDir 'index.js'))) { Say '! the CLI app is still missing - run the installer again' }
  }

  # ── Bun (the full TUI) ──────────────────────────────────────────────────
  $bunDir = Join-Path $Runtime 'bun'
  $bunExe = Join-Path $bunDir 'node_modules\bun\bin\bun.exe'
  $bunPick = Find-UsableBun
  if ($bunPick.Path) {
    # Bun's own installer writes to ~\.bun\bin, which is often missing from PATH
    # in the session the CLI is started from — Bun-Candidates already covers it.
    Say ("OK Bun " + (Format-BunVersion $bunPick.Version) + " is already here ($($bunPick.Path)) - using it")
  } else {
    if ($bunPick.Skipped.Count -gt 0) {
      Say ("! Bun " + $bunPick.Skipped[0] + " is older than the dashboard's " + ($MinBun -join '.') + " - installing " + $BunVersion + " beside the CLI")
    } else {
      Say '.. installing Bun for the full TUI (one time)'
    }
    $bunCode = Invoke-Npm @('install', '--prefix', $bunDir, '--omit=dev', '--no-audit', '--no-fund', "bun@$BunVersion")
    if ($bunCode -eq 0 -and (Test-Path $bunExe)) {
      $newBunVer = Get-BunVersion $bunExe
      Say ("OK Bun " + (Format-BunVersion $newBunVer) + " installed in $bunDir")
    }
    else {
      # npm is the quiet path; Bun's own installer is the one that always works.
      # This is the vendor's documented Windows install, and it is announced
      # before it runs — never a silent download (owner, 2026-11-26: a paid
      # machine must come up with the dashboard, "check if users have whats
      # needed if not install").
      Say '! npm could not install Bun - using Bun''s own installer (one time, announced here first)'
      # powershell.exe ships with every Windows; pwsh is the 7 host when the
      # installer itself was started from one. Neither name is guaranteed, so
      # the host is looked up instead of invoked bare (that is the same "not
      # recognized as a cmdlet" trap).
      $psHost = Get-Command powershell -ErrorAction SilentlyContinue
      if (-not $psHost) { $psHost = Get-Command pwsh -ErrorAction SilentlyContinue }
      if ($psHost -and $psHost.Source) {
        try {
          & ([string]$psHost.Source) -NoProfile -ExecutionPolicy Bypass -Command "irm bun.sh/install.ps1 | iex" 2>$null | Out-Null
        } catch { }
      }
      $bunPick = Find-UsableBun
      if ($bunPick.Path) {
        Say ("OK Bun " + (Format-BunVersion $bunPick.Version) + " installed ($($bunPick.Path)) - the dashboard TUI will open")
      } else {
        Say '! Bun could not be installed automatically.'
        Say '  Without Bun the CLI opens its simpler built-in Ink UI instead of the dashboard.'
        Say '  To get the full dashboard, run this once and start the CLI again:'
        Say '    irm bun.sh/install.ps1 | iex'
      }
    }
  }

  # Point the CLI at the server it came from.
  try { & $HaksterCmd config set server $Origin 2>$null | Out-Null } catch { }

  $version = ''
  try { $version = (& $HaksterCmd --version 2>$null | Select-Object -First 1) } catch { }
  Say ''
  if ($version) { Say "Installed: HaksterAI CLI $version" } else { Say 'Installed: HaksterAI CLI (version did not answer - check: hakster --version)' }
  Say "  files: $HaksterHome  (drive $(Get-DriveOf $HaksterHome))"
  if ($version -and $latestVersion -and ($version -ne $latestVersion)) {
    Say "  the server advertises v$latestVersion - re-run this installer to pick it up"
  }
  # §42: every install stays on the newest released build. This one is a package
  # install, so it does that by itself; say how to ask now.
  Say "  updates: automatic - 'hakster update' checks now; a newer build applies at the next start"

  # ── sign in ───────────────────────────────────────────────────────────────
  # Owner, 2026-11-26: the paid-plan flow carries its own sign-in, so a plan is
  # usable the moment this finishes. The CLI asks the server for a device code,
  # a magic link opens in the browser, the operator checks that the short code
  # matches and presses Allow - only then does this machine hold the account's
  # key, written straight into ~/.hakster/config.json (mode 600) and never
  # printed, logged or put on a command line (§9, §23).
  # Signing in proves who you are; the plan decides what the CLI may do, so this
  # reports the plan rather than assuming it. HAKSTER_NO_LOGIN=1 (or a
  # non-interactive host) skips the prompt and prints the command instead.
  function Get-Session {
    try {
      $raw = (& $HaksterCmd whoami --json 2>$null | Select-Object -Last 1)
      if (-not $raw) { return $null }
      return ($raw | ConvertFrom-Json)
    } catch { return $null }
  }

  Say ''
  $session = Get-Session
  $interactive = (-not $env:HAKSTER_NO_LOGIN) -and (-not $env:CI) -and [Environment]::UserInteractive
  if ($session -and $session.signedIn) {
    Say 'OK already signed in on this machine'
  } elseif ($interactive) {
    Say 'Sign in now? A magic link opens in your browser - press Allow there and this finishes by itself. [Y/n]'
    $answer = ''
    try { $answer = Read-Host '  sign in' } catch { $answer = 'n' }
    if ($answer -eq '' -or $answer -match '^(y|yes)$') {
      & $HaksterCmd login
      $session = Get-Session
    } else {
      Say '  skipped - run "hakster login" whenever you are ready'
    }
  } else {
    Say '  sign in:  hakster login'
  }

  $cliIncluded = $false
  if ($session -and $session.signedIn) {
    $who = if ($session.user.username) { '@' + $session.user.username } else { 'your account' }
    Say "OK signed in as $who - plan $($session.user.plan)"
    if ($session.cli -and $session.cli.included) {
      $cliIncluded = $true
      Say 'OK this plan includes the CLI'
    } else {
      Say "! this plan does not include the CLI - upgrade at $Origin/plans/"
    }
  }

  Say ''
  Say 'Next (open a new terminal so PATH applies):'
  if ($cliIncluded) {
    Say '  1) start your agent, or run Claude Code on this plan:'
    Say '       hakster            # our own terminal agent'
    Say '       hakster claude     # Claude Code on this plan (sets it up once if you have none)'
    Say ''
    Say '  Check any time:  hakster whoami'
  } else {
    Say '  1) sign in - a magic link opens in your browser, press Allow:'
    Say '       hakster login'
    Say '  2) start your agent once your plan includes the CLI:'
    Say '       hakster            # our own terminal agent'
    Say ''
    Say "  Plans:  $Origin/plans/    Check any time:  hakster whoami"
  }
  Say "  No browser handy?  `$env:HAKSTER_API_KEY='<key from $Origin/dashboard/>'"

  Remove-Item -Path $Tmp -Recurse -Force -ErrorAction SilentlyContinue
}
