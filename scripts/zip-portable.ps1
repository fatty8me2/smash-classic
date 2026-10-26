# Zips a directory with forward-slash entry names (the zip spec). Windows
# PowerShell 5.1's Compress-Archive and .NET Framework's ZipFile both write
# backslashes, which some extractors turn into literal "a\b" file names.
#
#   .\scripts\zip-portable.ps1 -Source dist\BattleShip -Destination dist\BattleShip-windows.zip
param(
    [Parameter(Mandatory = $true)][string]$Source,
    [Parameter(Mandatory = $true)][string]$Destination,
    [string]$Prefix = "",   # prepended to every entry name, e.g. "shaders/"
    [ValidateSet("Optimal", "Fastest", "NoCompression")][string]$Level = "Fastest"   # deflate level (Fastest ~ zlib 1)
)
Add-Type -AssemblyName System.IO.Compression, System.IO.Compression.FileSystem

$src = (Resolve-Path $Source).Path.TrimEnd('\')
if (Test-Path $Destination) { Remove-Item $Destination -Force }
$stream = [System.IO.File]::Open($Destination, [System.IO.FileMode]::CreateNew)
$archive = New-Object System.IO.Compression.ZipArchive($stream, [System.IO.Compression.ZipArchiveMode]::Create)
try {
    Get-ChildItem -Path $src -Recurse -File -Force | ForEach-Object {
        $name = $Prefix + $_.FullName.Substring($src.Length + 1).Replace('\', '/')
        $entry = $archive.CreateEntry($name, [System.IO.Compression.CompressionLevel]$Level)
        $entry.LastWriteTime = $_.LastWriteTime
        $out = $entry.Open()
        $in = [System.IO.File]::OpenRead($_.FullName)
        try { $in.CopyTo($out) } finally { $in.Dispose(); $out.Dispose() }
    }
} finally {
    $archive.Dispose()
    $stream.Dispose()
}
