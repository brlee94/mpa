param([Parameter(Mandatory=$true)][string]$Executable)
$ErrorActionPreference = 'Stop'
$Executable = (Resolve-Path -LiteralPath $Executable).Path
$root = Join-Path ([IO.Path]::GetTempPath()) ('EmlToPst-smoke-' + [guid]::NewGuid().ToString('N'))
$inputFolder = Join-Path $root 'input'
$childFolder = Join-Path $inputFolder 'Archive'
$null = New-Item -ItemType Directory -Path $childFolder -Force
$pst = Join-Path $root 'smoke.pst'
$fixture = @'
From: Sender <sender@example.com>
To: to@example.com
Cc: cc@example.com
Subject: =?UTF-8?B?7ZWc6riAIO2FjOyKpO2KuA==?=
Date: Thu, 22 Oct 2026 10:30:00 +0900
Received: from example.com by local; Thu, 22 Oct 2026 10:31:00 +0900
Message-ID: <smoke@example.com>
MIME-Version: 1.0
Content-Type: multipart/mixed; boundary="smoke"

--smoke
Content-Type: text/plain; charset=utf-8
Content-Transfer-Encoding: base64

7JWI64WV7ZWY7IS47JqU
--smoke
Content-Type: application/octet-stream; name="payload.bin"
Content-Disposition: attachment; filename="payload.bin"
Content-Transfer-Encoding: base64

AAECgP7/
--smoke--
'@
$fixture = $fixture.Replace("`r`n", "`n").Replace("`n", "`r`n")
[IO.File]::WriteAllText((Join-Path $inputFolder 'one.eml'), $fixture, [Text.UTF8Encoding]::new($false))
[IO.File]::WriteAllText((Join-Path $childFolder 'two.eml'), $fixture, [Text.UTF8Encoding]::new($false))
$refs = [Collections.Generic.List[object]]::new()
function Keep($value) {
    $refs.Add($value)
    return ,$value
}
function Assert($condition, [string]$message) {
    if (-not $condition) { throw $message }
    Write-Host "PASS $message"
}
$namespace = $null
$pstRoot = $null
try {
    $process = Start-Process -FilePath $Executable -ArgumentList @('--convert', ('"{0}"' -f $inputFolder), ('"{0}"' -f $pst)) -Wait -PassThru
    Assert ($process.ExitCode -eq 0) 'Conversion process completed successfully'
    Assert (Test-Path -LiteralPath $pst) 'PST was created'
    $reports = @(Get-ChildItem -LiteralPath $root -Filter '*.conversion.csv')
    Assert ($reports.Count -eq 1) 'Exactly one conversion report created'
    $rows = @(Import-Csv -LiteralPath $reports[0].FullName)
    Assert ($rows.Count -eq 2) 'Two input messages were processed'
    $app = Keep (New-Object -ComObject Outlook.Application)
    $namespace = Keep ($app.GetNamespace('MAPI'))
    $namespace.AddStoreEx($pst, 2)
    $stores = Keep ($namespace.Stores)
    for ($i = 1; $i -le $stores.Count; $i++) {
        $store = Keep ($stores.Item($i))
        if ($store.FilePath -eq $pst) { $pstRoot = Keep ($store.GetRootFolder()); break }
    }
    Assert ($null -ne $pstRoot) 'Output PST can be reopened by Outlook'
    $folders = Keep ($pstRoot.Folders)
    # Import root has a Korean name; use its message content to locate it without encoding assumptions.
    $import = $null
    for ($i = 1; $i -le $folders.Count; $i++) {
        $candidate = Keep ($folders.Item($i))
        $candidateItems = Keep ($candidate.Items)
        if ($candidateItems.Count -eq 1) { $import = $candidate; break }
    }
    Assert ($null -ne $import) 'Import root contains one top-level email'
    $items = Keep ($import.Items)
    $mail = Keep ($items.Item(1))
    $expectedSubject = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('7ZWc6riAIO2FjOyKpO2KuA=='))
    $expectedBody = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('7JWI64WV7ZWY7IS47JqU'))
    Assert ($mail.Subject -eq $expectedSubject) 'Korean subject preserved'
    Assert ($mail.Body.Trim() -eq $expectedBody) 'Korean body preserved'
    Assert ($mail.SenderEmailAddress -eq 'sender@example.com') 'Sender preserved'
    $recipients = Keep ($mail.Recipients)
    Assert ($recipients.Count -eq 2) 'To and Cc recipients preserved'
    $props = Keep ($mail.PropertyAccessor)
    $flags = $props.GetProperty('http://schemas.microsoft.com/mapi/proptag/0x0E070003')
    Assert (($flags -band 8) -eq 0) 'Imported message is not an unsent draft'
    $sent = $props.GetProperty('http://schemas.microsoft.com/mapi/proptag/0x00390040')
    $received = $props.GetProperty('http://schemas.microsoft.com/mapi/proptag/0x0E060040')
    Assert (($received - $sent).TotalSeconds -eq 60) 'Sent and received instants preserved separately'
    $attachments = Keep ($mail.Attachments)
    Assert ($attachments.Count -eq 2) 'Decoded attachment and original EML preserved'
    $attachment = Keep ($attachments.Item(1))
    $payload = Join-Path $root 'payload.bin'
    $attachment.SaveAsFile($payload)
    Assert ([Convert]::ToBase64String([IO.File]::ReadAllBytes($payload)) -eq 'AAECgP7/') 'Attachment bytes preserved'
    $original = Keep ($attachments.Item(2))
    $originalPath = Join-Path $root 'original.eml'
    $original.SaveAsFile($originalPath)
    Assert ((Get-FileHash -LiteralPath $originalPath).Hash -eq (Get-FileHash -LiteralPath (Join-Path $inputFolder 'one.eml')).Hash) 'Original EML preserved byte for byte'
    $children = Keep ($import.Folders)
    $archive = Keep ($children.Item('Archive'))
    $archiveItems = Keep ($archive.Items)
    Assert ($archiveItems.Count -eq 1) 'Source subfolder hierarchy preserved'
    # A second run must reject an existing PST and leave its contents unchanged.
    $process = Start-Process -FilePath $Executable -ArgumentList @('--convert', ('"{0}"' -f $inputFolder), ('"{0}"' -f $pst)) -Wait -PassThru
    Assert ($process.ExitCode -ne 0) 'Existing PST cannot be overwritten'
    Assert ($items.Count -eq 1 -and $archiveItems.Count -eq 1) 'Existing PST contents unchanged'
    Write-Host "Windows Outlook smoke checks passed. Test output retained at $root"
} finally {
    if ($null -ne $namespace -and $null -ne $pstRoot) {
        try { $namespace.RemoveStore($pstRoot) } catch { Write-Warning 'Close the test PST in Outlook before moving it.' }
    }
    for ($i = $refs.Count - 1; $i -ge 0; $i--) {
        if ([Runtime.InteropServices.Marshal]::IsComObject($refs[$i])) {
            $null = [Runtime.InteropServices.Marshal]::ReleaseComObject($refs[$i])
        }
    }
    # Do not quit Outlook or delete the user's data. Test output is retained for inspection.
}
