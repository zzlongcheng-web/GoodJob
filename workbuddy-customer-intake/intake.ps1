param([ValidateSet("authorize","check","create","batch","forget")][string]$Mode = "batch")
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
$base = "https://crm.goldengainmachinery.com/api/external-customer-intake"
if ($env:OS -ne "Windows_NT") { throw "This helper requires Windows." }
$folder = Join-Path ([Environment]::GetFolderPath("LocalApplicationData")) "GoldenGain\CustomerIntake"
$file = Join-Path $folder "authorization.dpapi"
if ($Mode -eq "authorize") {
    $token = Read-Host "Paste the personal CRM intake authorization (not your login password)" -AsSecureString
    $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($token)
    try {
        $plain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr)
        if ($plain -cnotmatch '^gj_intake_[A-Za-z0-9_-]{43}$') { throw "Invalid authorization format." }
        New-Item -Type Directory -Path $folder -Force | Out-Null
        $token | ConvertFrom-SecureString | Set-Content -LiteralPath $file -Encoding ASCII
    } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr); $plain = $null; $token.Dispose() }
    Write-Output "Authorization saved for the current Windows user. Clear the clipboard manually."
    exit
}
if ($Mode -eq "forget") {
    if (Test-Path -LiteralPath $file) { Remove-Item -LiteralPath $file -Force }
    Write-Output "Local authorization removed. Revoke it in CRM as well."
    exit
}
if (-not (Test-Path -LiteralPath $file)) { throw "Authorization missing; run authorize manually outside AI chat." }
$raw = [Console]::In.ReadToEnd()
if ($raw.Length -gt 500000) { throw "Input exceeds batch size limit." }
$parsed = ConvertFrom-Json -InputObject $raw
$items = @($parsed)
if ($items.Count -lt 1 -or $items.Count -gt 100) { throw "Use 1 to 100 customers per batch." }
if ($Mode -ne "batch" -and $items.Count -ne 1) { throw "check/create accepts exactly one customer." }
$secure = Get-Content -LiteralPath $file -Raw | ConvertTo-SecureString
$ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
$results = New-Object System.Collections.Generic.List[object]
$allowed = @("company","country","companyFullName","contact","email","phone","whatsapp","wechat","website","source","otherNotes")
try {
    $plain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr)
    if ($plain -cnotmatch '^gj_intake_[A-Za-z0-9_-]{43}$') { throw "Stored authorization invalid." }
    $headers = @{ Authorization = "Bearer $plain" }
    # Allow only this fixed endpoint; never follow a redirect carrying credentials.
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    $authFailed = $false
    for ($i = 0; $i -lt $items.Count; $i++) {
        $row = $items[$i]
        $result = [ordered]@{ index = $i + 1; company = [string]$row.company; status = "failed" }
        if ($authFailed) { $result.status = "not_attempted"; $results.Add([pscustomobject]$result); continue }
        if ($null -eq $row -or $row -isnot [pscustomobject] -or -not ([string]$row.company).Trim() -or -not ([string]$row.country).Trim() -or ([string]$row.country).Trim() -match '^(未知|unknown|n/a|待维护)$') {
            $result.status = "incomplete"; $results.Add([pscustomobject]$result); continue
        }
        $body = @{}
        foreach ($key in $allowed) {
            $field = $row.PSObject.Properties[$key]
            if ($null -ne $field -and $field.Value -is [string]) { $body[$key] = $field.Value }
        }
        $action = if ($Mode -eq "check") { "check" } else { "create" }
        try {
            $answer = Invoke-RestMethod -Method Post -Uri "$base/$action" -Headers $headers -ContentType "application/json; charset=utf-8" -Body ([Text.Encoding]::UTF8.GetBytes(($body | ConvertTo-Json -Compress))) -MaximumRedirection 0 -TimeoutSec 40
            if ($answer.status -eq "created" -and $answer.customerId) {
                $result.status = "created"; $result.customerId = [string]$answer.customerId
            } elseif ($action -eq "check" -and $answer.status -in @("clear","duplicate")) { $result.status = [string]$answer.status }
            else { $result.status = "unverified" }
        } catch {
            $code = 0
            if ($_.Exception.Response) { $code = [int]$_.Exception.Response.StatusCode }
            $result.httpStatus = $code
            switch ($code) {
                409 { $result.status = "duplicate" }
                400 { $result.status = "invalid" }
                401 { $result.status = "authorization_required"; $authFailed = $true }
                403 { $result.status = "forbidden"; $authFailed = $true }
                429 { $result.status = "rate_limited"; $authFailed = $true }
                default { $result.status = "unverified" }
            }
        }
        $results.Add([pscustomobject]$result)
    }
} finally {
    $headers = $null; $plain = $null
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr)
    $secure.Dispose()
}
[pscustomobject]@{ total = $items.Count; results = @($results.ToArray()) } | ConvertTo-Json -Depth 6
