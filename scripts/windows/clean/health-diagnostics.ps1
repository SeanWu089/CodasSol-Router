function Get-SafeHealth($Service, $Url) {
    try {
        $h = Invoke-RestMethod -Uri $Url -TimeoutSec 2 -ErrorAction Stop
        # Whitelist scalar status only. Never serialize a response body or exception message.
        return [pscustomobject]@{service=$Service; reachable=$true; ok=($h.ok -eq $true); serviceMatches=($Service -ne 'devspace' -or $h.name -eq 'devspace'); backendReachable=($h.backendReachable -eq $true); errorType=$null; httpStatus=$null}
    } catch {
        $code = $null
        if ($_.Exception.Response) { $code = [int]$_.Exception.Response.StatusCode }
        return [pscustomobject]@{service=$Service; reachable=$false; ok=$false; serviceMatches=$false; backendReachable=$false; errorType=$_.Exception.GetType().Name; httpStatus=$code}
    }
}
