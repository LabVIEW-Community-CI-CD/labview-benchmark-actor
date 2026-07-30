# Host mesh-traffic viewers

Three host-side ways to observe the Ubuntu mesh's `lbabus net` coordination (TCP bus 8776 + UDP presence
8777), reading endpoints from the gitignored [`../../mesh-actors.csv`](../../mesh-actors.csv.example).

| Viewer | File | What it shows |
| --- | --- | --- |
| Packet capture | [`capture.ps1`](capture.ps1) | L2 pktmon capture on the host-only vmnet, filtered to the mesh ports → `.etl` (open in Wireshark: `pktmon pcapng`) + a text summary. Sees traffic regardless of host firewall. |
| Read-only monitor | [`mesh-monitor.mjs`](mesh-monitor.mjs) | Passively receives UDP presence + connect-only TCP-probes the bus port. Never posts. |
| Live dashboard | [`mesh-monitor.mjs`](mesh-monitor.mjs) | Same tool: a per-actor table (id / ip / bus open-closed / last presence / beacon count). |

```powershell
# monitor + dashboard (no admin needed for the TCP-probe/table; UDP presence needs the firewall rule below)
node cleanroom/ubuntu-labview/mesh/viewers/mesh-monitor.mjs

# packet capture (ELEVATED shell — pktmon requires admin)
powershell -File cleanroom/ubuntu-labview/mesh/viewers/capture.ps1 -Seconds 10
```

## Host setup (one-time)

The mesh runs on a VMware host-only vmnet. Two host prerequisites for the L3 monitor (the L2 `capture.ps1`
needs neither, only elevation):

1. **Put the host on the mesh subnet** — VMware may leave the vmnet host adapter on APIPA:
   `New-NetIPAddress -InterfaceAlias 'VMware Network Adapter VMnet2' -IPAddress 192.168.56.1 -PrefixLength 24`
2. **Allow inbound UDP presence** (Windows Firewall blocks it by default):
   `New-NetFirewallRule -DisplayName 'lba-mesh-udp-8777' -Direction Inbound -Protocol UDP -LocalPort 8777 -Action Allow`

**Caveat:** VMware host-only vmnets do **not** reliably deliver subnet *broadcast* to the host vNIC, so the
host observes **unicast-to-host** presence (and any traffic via `capture.ps1` at L2). Inter-actor broadcast
presence stays on the virtual switch (the actors see each other).

## Demo traffic (until `lbabus net` runs on the actors)

The mesh actors currently carry LabVIEW but not `lbabus`, so there is no real bus traffic yet.
[`presence-beacon.py`](presence-beacon.py) is a stand-in generator (upload to an actor, run it) so the
viewers can be exercised now:

```bash
python3 /tmp/presence-beacon.py actor1 8777 60 192.168.56.1   # unicast presence to the host observer
```

**Next (WAITER=LINUX design):** install `lbabus` on the Ubuntu golden box / mesh actors so each actor runs
`lbabus net beacon`/`listen` and the viewers show REAL coordination — see the bus thread on the
`ubuntu-vmware-cleanroom-parity` task.
