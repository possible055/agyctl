import { spawn } from 'node:child_process';

const watchScript = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$sidecar = $null
$owner = $null
try {
    $request = [Console]::In.ReadToEnd() | ConvertFrom-Json
    $rows = @(Get-CimInstance Win32_Process)
    $current = @($rows | Where-Object { $_.ProcessId -eq $request.pid })
    if ($current.Count -ne 1) { throw 'Cannot identify the sidecar process' }
    $current = $current[0]
    $sidecar = [Diagnostics.Process]::GetProcessById([int]$request.pid)
    $null = $sidecar.Handle
    if ($sidecar.MainModule.FileName -ine $request.executablePath) { throw 'Sidecar image changed' }
    $created = $sidecar.StartTime.ToFileTimeUtc()
    $seen = @{}
    for ($depth = 0; $depth -lt 16; $depth++) {
        $ancestorPid = [int]$current.ParentProcessId
        if ($ancestorPid -le 0 -or $seen.ContainsKey($ancestorPid)) { throw 'Cannot verify the launcher ancestry' }
        $seen[$ancestorPid] = $true
        $ancestorRow = @($rows | Where-Object { $_.ProcessId -eq $ancestorPid })
        if ($ancestorRow.Count -ne 1) { throw 'The launcher owner has exited' }
        $ancestorRow = $ancestorRow[0]
        $ancestor = [Diagnostics.Process]::GetProcessById($ancestorPid)
        try {
            $null = $ancestor.Handle
            $ancestorCreated = $ancestor.StartTime.ToFileTimeUtc()
            if ($ancestorCreated -ge $created -or $ancestor.MainModule.FileName -ine $ancestorRow.ExecutablePath) {
                throw 'Launcher identity changed'
            }
            if ($ancestor.MainModule.FileName -ieq $request.executablePath -and
                $ancestorRow.CommandLine -and
                $ancestorRow.CommandLine -notmatch '(?:^|\s)--(?:type|import)(?:=|\s)') {
                $owner = $ancestor
                break
            }
            $created = $ancestorCreated
            $current = $ancestorRow
        } finally {
            if ($ancestor -ne $owner) { $ancestor.Dispose() }
        }
    }
    if ($null -eq $owner) { throw 'Cannot verify an Antigravity main process in the launcher ancestry' }
    @{ event = 'ready' } | ConvertTo-Json -Compress | ForEach-Object { [Console]::WriteLine($_) }
    while (-not $owner.WaitForExit(1000)) {
        if ($sidecar.HasExited) { exit 0 }
    }
    @{ event = 'owner-exited' } | ConvertTo-Json -Compress | ForEach-Object { [Console]::WriteLine($_) }
} catch {
    @{ event = 'error'; message = $_.Exception.Message } | ConvertTo-Json -Compress | ForEach-Object { [Console]::WriteLine($_) }
    exit 1
} finally {
    if ($null -ne $owner) { $owner.Dispose() }
    if ($null -ne $sidecar) { $sidecar.Dispose() }
}
`;

/** Pins the Windows launcher's main-process handle, rather than polling a reusable PID. */
export function watchHostProcess(onClose) {
  if (process.platform !== 'win32' || process.arch !== 'x64')
    throw new Error('Host lifetime monitoring requires Windows x86-64');
  return new Promise((resolve, reject) => {
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', watchScript],
      {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      },
    );
    let ready = false;
    let stopped = false;
    let buffer = '';
    let errors = '';
    const stop = () => {
      if (stopped) return;
      stopped = true;
      clearTimeout(deadline);
      process.off('exit', stop);
      child.kill();
    };
    const fail = (error) => {
      if (stopped) return;
      stop();
      if (ready) onClose(error);
      else reject(error);
    };
    const deadline = setTimeout(() => fail(new Error('Host lifetime inspection timed out')), 15000);
    process.once('exit', stop);
    child.on('error', fail);
    child.stdin.on('error', fail);
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      errors = `${errors}${chunk}`.slice(-4096);
    });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      if (Buffer.byteLength(buffer) > 65536) {
        fail(new Error('Invalid host lifetime response'));
        return;
      }
      for (let index = buffer.indexOf('\n'); index >= 0; index = buffer.indexOf('\n')) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (stopped || !line) continue;
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          fail(new Error('Invalid host lifetime response'));
          return;
        }
        if (message.event === 'ready' && !ready) {
          ready = true;
          clearTimeout(deadline);
          child.unref();
          child.stdin.unref();
          child.stdout.unref();
          child.stderr.unref();
          resolve(stop);
        } else if (message.event === 'owner-exited' && ready) {
          stop();
          onClose();
        } else fail(new Error(message.message ?? 'Cannot verify the Antigravity main process'));
      }
    });
    child.on('close', () => {
      fail(new Error(`Host lifetime monitor exited unexpectedly${errors ? `: ${errors}` : ''}`));
    });
    child.stdin.end(JSON.stringify({ pid: process.pid, executablePath: process.execPath }));
  });
}
