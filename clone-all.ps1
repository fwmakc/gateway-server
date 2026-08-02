<#
.SYNOPSIS
    Clones all microservices as sibling directories for Docker Compose.

.DESCRIPTION
    Run this in the directory where you want all services to live.
    Creates sibling directories for gateway-server, auth-server, api-server,
    event-server, api-server-toolkit, scaffold, and optional services.

    After cloning, cd into gateway-server and run:
      cp .env.example .env
      docker compose up -d --build
#>

$repos = @(
    "gateway-server",
    "api-server-toolkit",
    "auth-server",
    "api-server",
    "event-server",
    "message-server",
    "file-server",
    "chat-server",
    "scaffold"
)

$base = $PSScriptRoot ? $PSScriptRoot : Get-Location

Write-Host "`n=== Cloning all repositories into $base ===" -ForegroundColor Cyan

foreach ($repo in $repos) {
    $path = Join-Path $base $repo
    if (Test-Path $path) {
        Write-Host "  [skip] $repo (already exists)" -ForegroundColor Yellow
    } else {
        Write-Host "  [clone] $repo" -ForegroundColor Green
        git clone "https://github.com/fwmakc/$repo.git" $path 2>&1 | Out-Null
    }
}

Write-Host "`n=== Done ===" -ForegroundColor Cyan
Write-Host "All repositories cloned as sibling directories." -ForegroundColor Green
Write-Host "`nNext steps:" -ForegroundColor White
Write-Host "  cd gateway-server" -ForegroundColor White
Write-Host "  cp .env.example .env" -ForegroundColor White
Write-Host "  docker compose up -d --build" -ForegroundColor White
