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
  $Runtime = Join-Path $HOME '.hakster\runtime'
  $NpmPrefix = Join-Path $HOME '.hakster\npm'
  $Tmp = Join-Path ([IO.Path]::GetTempPath()) ("hakster-cli-install-" + [Guid]::NewGuid().ToString('n').Substring(0, 8))

  function Say($msg) { Write-Host $msg }
  function Fail($msg) {
    Write-Host "X $msg"
    Write-Host '  Nothing was installed.'
    throw $msg
  }

  # Mirrors cli/src/runtime-paths.js findBun(): the machine's own Bun wins, then
  # the one this installer brings. A fresh Bun install is usually missing from the
  # PATH of the session the CLI is later started from, so the well-known Windows
  # locations are checked directly — without that, an install says "no Bun" on a
  # machine that has one and the operator is sent to the dashboard-less Ink UI
  # (Surface Pro, 2026-11-26). Read-only: this never installs or edits anything.
  function Find-Bun {
    $onPath = Get-Command bun -ErrorAction SilentlyContinue
    if ($onPath) { return [string]$onPath.Source }
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
        if (Test-Path $full) { return $full }
      }
    }
    return ''
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
    if ((Get-NodeMajor) -ge 20 -and (Get-Command npm -ErrorAction SilentlyContinue)) {
      Say ("  OK node " + $nodeVer + " - used as it is")
    } else {
      Say ("  X  node " + $nodeVer + " is older than 20 - a Node 20+ runtime comes with this install")
    }
  } else {
    Say '  X  node - a Node 20+ runtime comes with this install (one time, about 32 MB)'
  }
  $bunFound = Find-Bun
  if ($bunFound) {
    Say "  OK bun ($bunFound) - our TUI runs on it"
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
  Push-Location $cliDir
  try {
    $packed = (& npm pack --silent --pack-destination $Tmp . 2>$null) | Select-Object -Last 1
    if (-not $packed -or -not $packed.EndsWith('.tgz')) { Fail 'could not pack the CLI for install' }
    $pkgPath = Join-Path $Tmp $packed
    if (-not (Test-Path $pkgPath)) { Fail 'could not pack the CLI for install' }

    # Pack first, install the tarball: a directory install is a link back into
    # the temp folder, which the cleanup would then delete.
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

  # ── Bun (the full TUI) ──────────────────────────────────────────────────
  $bunDir = Join-Path $Runtime 'bun'
  $bunExe = Join-Path $bunDir 'node_modules\bun\bin\bun.exe'
  $bunFound = Find-Bun
  if ($bunFound) {
    # Bun's own installer writes to ~\.bun\bin, which is often missing from PATH
    # in the session the CLI is started from — Find-Bun already covers it.
    Say "OK Bun is already here ($bunFound) - using it"
  } else {
    Say '.. installing Bun for the full TUI (one time)'
    & npm install --prefix $bunDir --omit=dev --no-audit --no-fund "bun@$BunVersion" 2>$null | Out-Null
    if ($LASTEXITCODE -eq 0 -and (Test-Path $bunExe)) { Say "OK Bun installed in $bunDir" }
    else {
      # npm is the quiet path; Bun's own installer is the one that always works.
      # This is the vendor's documented Windows install, and it is announced
      # before it runs — never a silent download (owner, 2026-11-26: a paid
      # machine must come up with the dashboard, "check if users have whats
      # needed if not install").
      Say '! npm could not install Bun - using Bun''s own installer (one time, announced here first)'
      try {
        & powershell -NoProfile -ExecutionPolicy Bypass -Command "irm bun.sh/install.ps1 | iex" 2>$null | Out-Null
      } catch { }
      $bunFound = Find-Bun
      if ($bunFound) {
        Say "OK Bun installed ($bunFound) - the dashboard TUI will open"
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
