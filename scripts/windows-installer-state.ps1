param([Parameter(Mandatory=$true)][string]$InstallDirectory)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false
if ($env:OS -ne 'Windows_NT') { throw 'Windows installer inspection requires Windows.' }
$key = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\MemCode'
$item = Get-ItemProperty -LiteralPath $key -ErrorAction SilentlyContinue
$product = Get-ItemProperty -LiteralPath 'HKCU:\Software\memtrace\MemCode' -ErrorAction SilentlyContinue
$shell = New-Object -ComObject WScript.Shell
$links = foreach ($path in @((Join-Path ([Environment]::GetFolderPath('Programs')) 'MemCode.lnk'), (Join-Path ([Environment]::GetFolderPath('Desktop')) 'MemCode.lnk'))) {
  $exists = Test-Path -LiteralPath $path
  @{ path=$path; exists=$exists; target=$(if ($exists) { $shell.CreateShortcut($path).TargetPath } else { $null }) }
}
$webview = @('HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}', 'HKCU:\SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}') | ForEach-Object { (Get-ItemProperty -LiteralPath $_ -ErrorAction SilentlyContinue).pv } | Where-Object { $_ } | Select-Object -First 1
@{
  registration=$(if ($item) { @{ name=$item.DisplayName; version=$item.DisplayVersion; location=$item.InstallLocation; uninstall=$item.UninstallString } } else { $null });
  rememberedLocation=$(if ($product) { $product.'(default)' } else { $null });
  executablePresent=(Test-Path -LiteralPath (Join-Path $InstallDirectory 'memcode.exe'));
  uninstallerPresent=(Test-Path -LiteralPath (Join-Path $InstallDirectory 'uninstall.exe'));
  shortcuts=@($links); webviewVersion=$webview
} | ConvertTo-Json -Depth 5 -Compress
