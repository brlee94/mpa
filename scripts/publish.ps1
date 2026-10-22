$Runtime = 'win-x64'
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Push-Location $root
try {
    dotnet publish src/EmlToPst.Windows/EmlToPst.Windows.csproj --configuration Release --runtime $Runtime --self-contained true `
        -p:RestoreLockedMode=true "-p:NuGetLockFilePath=packages.$Runtime.lock.json" `
        -p:PublishSingleFile=true -p:IncludeNativeLibrariesForSelfExtract=true -p:EnableCompressionInSingleFile=true -p:DebugType=None `
        --output "artifacts/$Runtime"
    if ($LASTEXITCODE -ne 0) { throw 'Publish failed.' }
} finally { Pop-Location }
