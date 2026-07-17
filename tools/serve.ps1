# ============================================================
# Capiq — Mini serveur HTTP statique pour la webapp (dev local)
# Zéro dépendance : fonctionne sur tout Windows (PowerShell 5.1+).
#
# Usage :  powershell -ExecutionPolicy Bypass -File tools\serve.ps1 [-Port 8080]
# Puis  :  http://localhost:8080  (localhost = contexte sécurisé :
#          Service Worker et Web Bluetooth fonctionnent)
#
# Alternative si Python est installé :
#          python -m http.server 8080 -d webapp
# ============================================================

param(
    [int]$Port = 8080,
    [string]$Root = (Join-Path $PSScriptRoot "..\webapp")
)

$Root = (Resolve-Path $Root).Path

$mime = @{
    ".html"        = "text/html; charset=utf-8"
    ".css"         = "text/css; charset=utf-8"
    ".js"          = "text/javascript; charset=utf-8"
    ".mjs"         = "text/javascript; charset=utf-8"
    ".json"        = "application/json; charset=utf-8"
    ".webmanifest" = "application/manifest+json; charset=utf-8"
    ".png"         = "image/png"
    ".jpg"         = "image/jpeg"
    ".svg"         = "image/svg+xml"
    ".ico"         = "image/x-icon"
    ".woff2"       = "font/woff2"
}

$listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, $Port)
$listener.Start()
Write-Host "Capiq webapp servie sur http://localhost:$Port  (racine : $Root)"
Write-Host "Ctrl+C pour arreter."

function Send-Response($stream, [int]$code, [string]$reason, [string]$contentType, [byte[]]$body) {
    $header = "HTTP/1.1 $code $reason`r`n" +
              "Content-Type: $contentType`r`n" +
              "Content-Length: $($body.Length)`r`n" +
              "Cache-Control: no-cache`r`n" +
              "Connection: close`r`n`r`n"
    $headerBytes = [System.Text.Encoding]::ASCII.GetBytes($header)
    $stream.Write($headerBytes, 0, $headerBytes.Length)
    if ($body.Length -gt 0) { $stream.Write($body, 0, $body.Length) }
}

while ($true) {
    $client = $listener.AcceptTcpClient()
    try {
        # Chrome ouvre des connexions speculatives sans requete : un timeout
        # de lecture evite qu'elles gelent ce serveur mono-thread.
        $client.ReceiveTimeout = 1500
        $client.NoDelay = $true
        $stream = $client.GetStream()
        $reader = [System.IO.StreamReader]::new($stream, [System.Text.Encoding]::ASCII, $false, 8192, $true)
        $requestLine = $reader.ReadLine()
        while (($line = $reader.ReadLine()) -and $line -ne "") { }  # vide les en-tetes

        if (-not $requestLine) { $client.Close(); continue }
        $parts = $requestLine.Split(" ")
        $method = $parts[0]
        $rawPath = if ($parts.Length -gt 1) { $parts[1] } else { "/" }

        $path = [System.Uri]::UnescapeDataString(($rawPath.Split("?")[0]))
        if ($path.EndsWith("/")) { $path += "index.html" }

        # Anti-traversee : resolution puis verification du prefixe racine
        $fsPath = [System.IO.Path]::GetFullPath((Join-Path $Root ($path.TrimStart("/") -replace "/", "\")))

        if ($method -ne "GET" -and $method -ne "HEAD") {
            Send-Response $stream 405 "Method Not Allowed" "text/plain" ([System.Text.Encoding]::UTF8.GetBytes("405"))
        }
        elseif (-not $fsPath.StartsWith($Root, [System.StringComparison]::OrdinalIgnoreCase) -or -not (Test-Path $fsPath -PathType Leaf)) {
            Send-Response $stream 404 "Not Found" "text/plain; charset=utf-8" ([System.Text.Encoding]::UTF8.GetBytes("404 - $path"))
        }
        else {
            $ext = [System.IO.Path]::GetExtension($fsPath).ToLower()
            $type = if ($mime.ContainsKey($ext)) { $mime[$ext] } else { "application/octet-stream" }
            $body = if ($method -eq "HEAD") { [byte[]]@() } else { [System.IO.File]::ReadAllBytes($fsPath) }
            Send-Response $stream 200 "OK" $type $body
            Write-Host "$method $path -> 200"
        }
        $stream.Flush()
    }
    catch {
        Write-Host "Erreur requete : $_"
    }
    finally {
        $client.Close()
    }
}
