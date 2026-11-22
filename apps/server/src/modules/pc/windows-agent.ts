import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Generates the self-contained Windows PC Computer Use agent (`agent.ps1`) and one-click
 * Tailscale-locked installer (`install-devdash-pc.ps1`).
 *
 * Security invariants enforced on the Windows host:
 *  1. Binds TcpListener strictly to the PC's Tailscale IPv4 (100.64.0.0/10) — never 0.0.0.0.
 *  2. Application-layer RemoteEndPoint check allows ONLY the configured VPS Tailscale IP.
 *  3. Windows Firewall rule restricts inbound TCP on the agent port strictly to the VPS Tailscale IP.
 *  4. Constant-time Bearer token check on every request.
 *  5. Live Tailscale watchdog + Windows System Tray kill-switch immediately stop control when
 *     Tailscale disconnects or the user clicks Pause.
 */

export type InstallerParams = {
  pcName: string
  tailscaleIp: string
  vpsTailscaleIp: string
  port: number
  token: string
  allowShell: boolean
}

function psQuote(s: string): string {
  return `'${s.replace(/'/g, "''")}'`
}

export function renderWindowsAgentScript(): string {
  return readFileSync(join(import.meta.dirname, 'agent.ps1'), 'utf8')
}

export function renderWindowsInstallerScript(p: InstallerParams): string {
  const agentBase64 = Buffer.from(renderWindowsAgentScript(), 'utf8').toString('base64')
  const configJson = JSON.stringify(
    {
      pcName: p.pcName,
      tailscaleIp: p.tailscaleIp,
      vpsTailscaleIp: p.vpsTailscaleIp,
      port: p.port,
      token: p.token,
      allowShell: p.allowShell,
    },
    null,
    2,
  )
  const configBase64 = Buffer.from(configJson, 'utf8').toString('base64')

  return [
    '#Requires -Version 5.1',
    '# DevDash PC Computer Use Installer (Tailscale-Only)',
    '$ErrorActionPreference = "Stop"',
    '',
    'Write-Host ""',
    'Write-Host "=== DevDash PC Computer Use Installer ===" -ForegroundColor Cyan',
    'Write-Host "Strict Tailscale-only mode: binds ONLY to your Tailscale IP and allows ONLY your DevDash VPS."',
    'Write-Host ""',
    '',
    '# 1. Verify Tailscale is installed and connected',
    '$tsExe = @("C:\\Program Files\\Tailscale\\tailscale.exe", "C:\\Program Files (x86)\\Tailscale\\tailscale.exe") | Where-Object { Test-Path $_ } | Select-Object -First 1',
    'if (-not $tsExe) { $cmd = Get-Command tailscale.exe -ErrorAction SilentlyContinue; if ($cmd) { $tsExe = $cmd.Source } }',
    'if (-not $tsExe) { throw "Tailscale is not installed on this PC. Install Tailscale and sign in first." }',
    '$liveIp = (& $tsExe ip -4 2>$null | Select-Object -First 1).Trim()',
    'if (-not $liveIp -or $liveIp -notmatch "^100\\.") { throw "Tailscale is not connected on this PC. Connect Tailscale first, then re-run this installer." }',
    `Write-Host ("Tailscale connected: $liveIp (expected " + ${psQuote(p.tailscaleIp)} + ")") -ForegroundColor Green`,
    '',
    '# 2. Write agent files into %LOCALAPPDATA%\\DevDash\\pc-agent',
    '$dir = Join-Path $env:LOCALAPPDATA "DevDash\\pc-agent"',
    'New-Item -ItemType Directory -Path $dir -Force | Out-Null',
    `$agentB64 = ${psQuote(agentBase64)}`,
    `$configB64 = ${psQuote(configBase64)}`,
    '$agentPath = Join-Path $dir "agent.ps1"',
    '$configPath = Join-Path $dir "config.json"',
    '[IO.File]::WriteAllBytes($agentPath, [Convert]::FromBase64String($agentB64))',
    '[IO.File]::WriteAllBytes($configPath, [Convert]::FromBase64String($configB64))',
    '',
    '# Update config with live Tailscale IP if different',
    '$cfg = Get-Content -Raw $configPath | ConvertFrom-Json',
    '$cfg.tailscaleIp = $liveIp',
    '$cfg | ConvertTo-Json -Depth 5 | Set-Content -Path $configPath -Encoding UTF8',
    '',
    '# Restrict config.json permissions to current user only (protects bearer token)',
    'try { & icacls $configPath /inheritance:r /grant:r "$($env:USERNAME):(R,W)" | Out-Null } catch {}',
    '',
    '# 3. Configure Windows Firewall rule (allows ONLY DevDash VPS Tailscale IP)',
    '$ruleName = "DevDash-PC-Agent-Tailscale"',
    `$port = ${p.port}`,
    `$vpsIp = ${psQuote(p.vpsTailscaleIp)}`,
    '$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)',
    'if ($isAdmin) {',
    '  Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue | Remove-NetFirewallRule -ErrorAction SilentlyContinue',
    '  New-NetFirewallRule -DisplayName $ruleName -Direction Inbound -Action Allow -Protocol TCP -LocalPort $port -LocalAddress $liveIp -RemoteAddress $vpsIp -Profile Any | Out-Null',
    '  Write-Host "Windows Firewall locked: TCP $port allowed ONLY from DevDash VPS ($vpsIp)." -ForegroundColor Green',
    '} else {',
    '  Write-Host "Note: Run PowerShell as Administrator once to add the strict Windows Firewall rule:" -ForegroundColor Yellow',
    '  Write-Host "  New-NetFirewallRule -DisplayName $ruleName -Direction Inbound -Action Allow -Protocol TCP -LocalPort $port -LocalAddress $liveIp -RemoteAddress $vpsIp -Profile Any" -ForegroundColor Gray',
    '}',
    '',
    '# 4. Create stop & launch helpers + Startup shortcut',
    '$stopPath = Join-Path $dir "stop-agent.ps1"',
    'Set-Content -Path $stopPath -Encoding UTF8 -Value "Get-CimInstance Win32_Process | Where-Object { `$_.CommandLine -like \x27*DevDash\\\\pc-agent\\\\agent.ps1*\x27 } | ForEach-Object { Stop-Process -Id `$_.ProcessId -Force }"',
    '',
    '# Stop any previous instance',
    'try { & $stopPath } catch {}',
    'Start-Sleep -Milliseconds 400',
    '',
    '# Launch hidden in background with System Tray kill-switch',
    '$vbsPath = Join-Path $dir "launch-agent.vbs"',
    'Set-Content -Path $vbsPath -Encoding ASCII -Value ("Set sh = CreateObject(""WScript.Shell"")" + "`r`n" + "sh.Run ""powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File """"" + $agentPath + """"""", 0, False")',
    '$startupLink = Join-Path ([Environment]::GetFolderPath("Startup")) "DevDash PC Agent.lnk"',
    'try {',
    '  $ws = New-Object -ComObject WScript.Shell',
    '  $sc = $ws.CreateShortcut($startupLink)',
    '  $sc.TargetPath = "wscript.exe"',
    '  $sc.Arguments = """$vbsPath"""',
    '  $sc.WorkingDirectory = $dir',
    '  $sc.Description = "DevDash Tailscale-only PC Computer Use Agent"',
    '  $sc.Save()',
    '} catch {}',
    '',
    'Start-Process -FilePath "wscript.exe" -ArgumentList """$vbsPath""" -WorkingDirectory $dir',
    'Start-Sleep -Seconds 2',
    'Write-Host ""',
    'Write-Host "DevDash PC Agent is running! Look for the shield icon in your Windows System Tray." -ForegroundColor Green',
    'Write-Host "You can pause or stop AI access anytime from the tray icon or by turning off Tailscale." -ForegroundColor Cyan',
    '',
  ].join('\r\n')
}
