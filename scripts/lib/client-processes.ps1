$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;

public static class AgyctlProcessIdentity {
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool QueryFullProcessImageNameW(IntPtr handle, uint flags, StringBuilder name, ref uint size);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool GetProcessTimes(IntPtr handle, out long created, out long exited, out long kernel, out long user);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool ReadProcessMemory(IntPtr handle, IntPtr address, byte[] buffer, UIntPtr size, out UIntPtr read);
    [DllImport("ntdll.dll")]
    static extern int NtQueryInformationProcess(IntPtr handle, int type, byte[] buffer, int size, out int returned);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool TerminateProcess(IntPtr handle, uint code);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);

    static byte[] Read(IntPtr handle, long address, int count) {
        if (address <= 0 || count <= 0 || count > 65536) throw new Exception("Invalid process parameters");
        var buffer = new byte[count];
        UIntPtr read;
        if (!ReadProcessMemory(handle, new IntPtr(address), buffer, (UIntPtr)count, out read) || read.ToUInt64() != (ulong)count)
            throw new Win32Exception(Marshal.GetLastWin32Error());
        return buffer;
    }

    static string Unicode(IntPtr handle, byte[] parameters, int offset) {
        int length = BitConverter.ToUInt16(parameters, offset);
        int maximum = BitConverter.ToUInt16(parameters, offset + 2);
        if (length == 0 || length > maximum || length % 2 != 0) throw new Exception("Invalid process string");
        return Encoding.Unicode.GetString(Read(handle, BitConverter.ToInt64(parameters, offset + 8), length));
    }

    static string[] Identify(IntPtr handle, bool details) {
        var name = new StringBuilder(32768);
        uint size = (uint)name.Capacity;
        long created, exited, kernel, user;
        if (!QueryFullProcessImageNameW(handle, 0, name, ref size) || !GetProcessTimes(handle, out created, out exited, out kernel, out user))
            throw new Win32Exception(Marshal.GetLastWin32Error());
        if (exited != 0) throw new Exception("Process has exited");
        if (!details) return new[] { name.ToString(), created.ToString() };
        // Windows x64 RTL_USER_PROCESS_PARAMETERS: validate the known image and command fields before trusting CurrentDirectory.
        if (IntPtr.Size != 8) throw new Exception("Process inspection requires Windows x64");
        var basic = new byte[48];
        int returned;
        if (NtQueryInformationProcess(handle, 0, basic, basic.Length, out returned) != 0 || returned != basic.Length)
            throw new Exception("Cannot query process parameters");
        long peb = BitConverter.ToInt64(basic, 8);
        long parameterAddress = BitConverter.ToInt64(Read(handle, peb + 0x20, 8), 0);
        var parameters = Read(handle, parameterAddress, 0x80);
        string image = Unicode(handle, parameters, 0x60);
        if (!String.Equals(image, name.ToString(), StringComparison.OrdinalIgnoreCase))
            throw new Exception("Unsupported process parameter layout");
        return new[] { name.ToString(), created.ToString(), Unicode(handle, parameters, 0x38), Unicode(handle, parameters, 0x70) };
    }

    public static string[] Inspect(int pid, bool details) {
        IntPtr handle = OpenProcess(0x1000u | (details ? 0x10u : 0u), false, pid);
        if (handle == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
        try { return Identify(handle, details); }
        finally { CloseHandle(handle); }
    }

    public static void Stop(int pid, string path, string created, string directory, string command) {
        IntPtr handle = OpenProcess(0x1000u | 0x10u | 0x1u | 0x100000u, false, pid);
        if (handle == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
        try {
            var actual = Identify(handle, true);
            if (!String.Equals(actual[0], path, StringComparison.OrdinalIgnoreCase) || actual[1] != created ||
                !String.Equals(actual[2], directory, StringComparison.OrdinalIgnoreCase) || actual[3] != command)
                throw new Exception("Process identity changed; nothing was stopped");
            if (!TerminateProcess(handle, 0)) throw new Win32Exception(Marshal.GetLastWin32Error());
            if (WaitForSingleObject(handle, 5000) != 0) throw new Exception("Sidecar did not exit");
        } finally { CloseHandle(handle); }
    }
}
'@

function Get-ProcessRecord($row, [bool]$details) {
    $identity = [AgyctlProcessIdentity]::Inspect([int]$row.ProcessId, $details)
    $record = @{
        pid = [int]$row.ProcessId
        parentPid = [int]$row.ParentProcessId
        path = $identity[0]
        created = $identity[1]
    }
    if ($details) {
        if ($identity[3] -cne $row.CommandLine) { throw 'Process command changed during inspection' }
        $record.directory = $identity[2]
        $record.command = $identity[3]
    }
    return $record
}

function Get-Inventory($request) {
    $rows = @(Get-CimInstance Win32_Process)
    $result = @(foreach ($row in $rows) {
        if ($row.Name -notin @([IO.Path]::GetFileName($request.executablePath), [IO.Path]::GetFileName($request.binaryPath))) { continue }
        if (-not $row.ExecutablePath) { throw 'Cannot resolve a matching process image' }
        if ($row.ExecutablePath -notin @($request.executablePath, $request.binaryPath)) { continue }
        $isSidecar = $row.ExecutablePath -eq $request.executablePath -and $row.CommandLine -match 'register_loader\.js'
        $record = Get-ProcessRecord $row $isSidecar
        $record.kind = if ($row.ExecutablePath -eq $request.binaryPath) { 'server' } elseif ($isSidecar) { 'sidecar' } else { 'client' }
        if ($isSidecar) {
            $parentRow = @($rows | Where-Object { $_.ProcessId -eq $row.ParentProcessId })
            if ($parentRow.Count -ne 1) { throw 'Cannot verify the sidecar launcher' }
            $record.parent = Get-ProcessRecord $parentRow[0] $true
            $ownerRow = @($rows | Where-Object { $_.ProcessId -eq $parentRow[0].ParentProcessId })
            $record.owner = if ($ownerRow.Count -eq 1) { Get-ProcessRecord $ownerRow[0] $false } else { $null }
        }
        $record
    })
    return $result
}

function Assert-SameProcess($record, $expected) {
    foreach ($field in @('path', 'created', 'directory', 'command', 'parentPid')) {
        if ($record[$field] -cne $expected.$field) { throw 'Process identity changed; cleanup stopped' }
    }
    foreach ($field in @('pid', 'path', 'created', 'directory', 'command', 'parentPid')) {
        if ($record.parent[$field] -cne $expected.parent.$field) { throw 'Launcher identity changed; cleanup stopped' }
    }
    if (($null -eq $record.owner) -ne ($null -eq $expected.owner)) { throw 'Launcher owner changed; cleanup stopped' }
    if ($null -ne $record.owner) {
        foreach ($field in @('pid', 'path', 'created', 'parentPid')) {
            if ($record.owner[$field] -cne $expected.owner.$field) { throw 'Launcher owner changed; cleanup stopped' }
        }
    }
}

try {
    $request = [Console]::In.ReadToEnd() | ConvertFrom-Json
    if ($request.action -notin @('inspect', 'cleanup')) { throw 'Invalid process action' }
    $records = @(Get-Inventory $request)
    if ($request.action -eq 'cleanup') {
        if ($records.Count -ne @($request.expected).Count) { throw 'Process inventory changed; nothing was stopped' }
        foreach ($record in $records) {
            $expected = @($request.expected | Where-Object { $_.pid -eq $record.pid })
            if ($expected.Count -ne 1 -or $record.kind -ne 'sidecar') { throw 'Unverified process; nothing was stopped' }
            Assert-SameProcess $record $expected[0]
        }
        $stopped = @()
        foreach ($record in $records) {
            $latest = @(Get-Inventory $request)
            $remaining = @($request.expected | Where-Object { $_.pid -notin $stopped })
            if ($latest.Count -ne $remaining.Count) { throw 'Process inventory changed; cleanup stopped' }
            foreach ($current in $latest) {
                $expected = @($remaining | Where-Object { $_.pid -eq $current.pid })
                if ($expected.Count -ne 1 -or $current.kind -ne 'sidecar') { throw 'Unverified process; cleanup stopped' }
                Assert-SameProcess $current $expected[0]
            }
            [AgyctlProcessIdentity]::Stop($record.pid, $record.path, $record.created, $record.directory, $record.command)
            $stopped += $record.pid
        }
    }
    @{ processes = $records } | ConvertTo-Json -Depth 6 -Compress
} catch {
    @{ error = $_.Exception.Message } | ConvertTo-Json -Compress
    exit 1
}
