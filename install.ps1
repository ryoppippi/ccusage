$repo   = "https://github.com/r1di/ccusage.git"
$branch = "feat/statusline-improvements"
$dir    = "$env:USERPROFILE\.ccusage-fork"
$pkg    = "$dir\apps\ccusage"
$dist   = "$pkg\dist\index.js"

Write-Host "ccusage statusline installer (r1di fork)"

foreach ($cmd in @("node","git")) {
    if (-not (Get-Command $cmd -ErrorAction SilentlyContinue)) {
        Write-Host "ERROR: '$cmd' not found." -ForegroundColor Red; exit 1
    }
}

if (-not (Get-Command pnpm -ErrorAction SilentlyContinue)) {
    Write-Host "Installing pnpm..."
    npm install -g pnpm --loglevel=error
}

if (Test-Path "$dir\.git") {
    Write-Host "Updating repo..."
    git -C $dir fetch origin
    git -C $dir checkout $branch
    git -C $dir reset --hard "origin/$branch"
} else {
    Write-Host "Cloning repo..."
    git clone --branch $branch --depth 1 $repo $dir
}

Write-Host "Building..."
Set-Location $pkg
pnpm install --frozen-lockfile=false
pnpm run build

Write-Host "Configuring Claude Code settings.json..."
$settings_path = "$env:USERPROFILE\.claude\settings.json"
if (-not (Test-Path "$env:USERPROFILE\.claude")) { New-Item -ItemType Directory -Path "$env:USERPROFILE\.claude" | Out-Null }
if (Test-Path $settings_path) {
    try { $s = (Get-Content $settings_path -Raw -Encoding UTF8) | ConvertFrom-Json }
    catch { $s = [PSCustomObject]@{} }
} else { $s = [PSCustomObject]@{} }
$s | Add-Member -MemberType NoteProperty -Name "statusLine" -Value ([PSCustomObject]@{
    type    = "command"
    command = "node `"$dist`" statusline"
}) -Force
$s | ConvertTo-Json -Depth 20 | Set-Content $settings_path -Encoding UTF8

Write-Host "Done. Restart Claude Code to activate the statusline." -ForegroundColor Green
