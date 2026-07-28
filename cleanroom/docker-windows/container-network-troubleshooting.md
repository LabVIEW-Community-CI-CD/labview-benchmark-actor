# Container network troubleshooting (Hyper-V-isolated Windows containers)

The `docker-windows` clean-room build needs **outbound internet inside the container** (the shared
`bootstrap.ps1` fetches MinGit, the dotnet SDK, ripgrep/gh/glab, and builds `lbabus`). On a Win11-client host
the default isolation is **Hyper-V**, and a common blocker is that a freshly-run container has **no outbound
network** even though the host is online.

## Symptom (WIN plane, confirmed)
Inside a plain `servercore` container:
- `Resolve-DnsName github.com` -> **DNS server failure**, AND
- `Invoke-WebRequest https://1.1.1.1` (raw IP, no DNS) -> **timeout**.

Both DNS *and* raw-IP failing means it is **not just DNS** — outbound **routing/NAT** itself is broken (packets
never leave the container). The host has internet; only the container NAT path is down.

## Ordered remediation (host-side; most need an elevated shell)
Apply in order; re-test with `docker run --rm mcr.microsoft.com/windows/servercore:ltsc2022 powershell -c "Invoke-WebRequest https://1.1.1.1 -UseBasicParsing -TimeoutSec 10"` after each.

1. **Auto-diagnose first** (read-only): `Invoke-WebRequest https://aka.ms/Debug-ContainerHost.ps1 -UseBasicParsing | Invoke-Expression` — Microsoft's container-host checker flags NAT/HNS/firewall problems.
2. **Restart Docker Desktop** (or the engine): often re-creates the `nat` network + HNS endpoints and is enough.
3. **Rebuild the NAT network via HNS** (elevated): the default `nat` network is stale.
   ```powershell
   Stop-Service docker
   Get-HNSNetwork | Where-Object { $_.Type -eq 'nat' } | Remove-HNSNetwork
   Start-Service docker      # docker recreates the default nat network on start
   ```
   If `Get-HNSNetwork` is unavailable, install the HNS helper: `Install-Module HostNetworkingService -Force` (or the older `Import-Module (Join-Path $env:ProgramFiles 'docker\cli-plugins\...'))`).
4. **Reset WinNAT** (elevated) if the NAT object is wedged:
   ```powershell
   Get-NetNat | Remove-NetNat -Confirm:$false
   Restart-Service winnat
   Stop-Service docker; Start-Service docker
   ```
5. **Force a working DNS** on the run (if raw-IP now works but names still fail): `docker run --dns 1.1.1.1 ...`, or set it engine-wide in `C:\ProgramData\docker\config\daemon.json`:
   ```json
   { "dns": ["1.1.1.1", "8.8.8.8"] }
   ```
   then `Restart-Service docker`.
6. **MTU mismatch** (common behind a VPN / on some routers — WIN's host uses a 192.168.178.1 gateway + a
   172.25.80.0/20 NAT subnet): a NAT vSwitch MTU larger than the physical link silently drops packets. Pin a
   safe MTU in `daemon.json` and restart docker:
   ```json
   { "mtu": 1400 }
   ```
7. **VPN / third-party firewall**: a VPN client or endpoint firewall can block forwarding for the 172.x NAT
   subnet. Temporarily disconnect the VPN / allow the NAT subnet outbound, then re-test.

## Build-time workaround (no host-network change)
If host NAT cannot be changed right now, **pre-stage every download into the build context** so the container
build needs no internet:
- The LabVIEW/VI-Analyzer install already uses **host-extracted offline feeds** (`LV_EXTRACTED_FEED`), so that
  layer is already offline.
- For `bootstrap.ps1`, stage MinGit + the dotnet SDK + the rg/gh/glab archives into the context and point the
  bootstrap at the local copies (a follow-up `bootstrap` offline-mode arg), mirroring the offline-feed pattern.

## References
- Troubleshoot Windows containers: `learn.microsoft.com/en-us/virtualization/windowscontainers/troubleshooting`
- `Debug-ContainerHost.ps1`: `aka.ms/Debug-ContainerHost.ps1`
