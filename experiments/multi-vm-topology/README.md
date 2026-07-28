# Multi-VM Vagrant topology (LBA-REQ-006 / T-006)

Proves that two **self-contained golden-box** VMs coordinate over the local `lbabus net`
TCP/UDP bus (LBA-REQ-007, ADR-0003/0004) with **unique identities** and a **clean teardown** —
the acceptance criteria for **LBA-REQ-006** ("multiple Vagrant VMs coordinating over a local
TCP/UDP bus").

What is proven, cross-VM (see [receipt.json](receipt.json) for a captured run):

| Signal | Transport | Evidence |
| --- | --- | --- |
| Presence | UDP beacons (`task:presence`) | actor-a receives 2× `ACTOR-B present` |
| Claim / handoff / done | ordered, reliable TCP | actor-a receives `CLAIM`, `HANDOFF`, `DONE` (`task:benchmark`) |
| Acknowledgement | TCP `--echo` reply | actor-b receives 3× `ACK … ackOf:<id>` from `ACTOR-A` |
| Unique identity | `VIHS_COLLAB_AGENT` | frames carry `ACTOR-A` / `ACTOR-B` senders |
| Comms-only | — | only coordination envelopes cross the wire (no run data / frames / images) |

## Layout

- [Vagrantfile](Vagrantfile) — two actors (`actor-a`, `actor-b`) on a shared host-only
  `private_network`, box `vihs/labview-cleanroom-sc`, no synced folder, no provisioner
  (comms-only). Knobs: `VIHS_CLEANROOM_BOX`, `VIHS_TOPO_MEM` (default 2048), `VIHS_TOPO_CPUS`.
- [run-topology.ps1](run-topology.ps1) — host-side driver: discovers the VM IPs, opens the
  collector firewall, runs the collector listener, fires the sender, asserts every signal
  above, and writes [receipt.json](receipt.json).
- [receipt.json](receipt.json) — machine-readable proof of the most recent run
  (`schema: labview-benchmark-actor/multi-vm-topology-receipt-v1`).

## Re-run

```powershell
# from this directory, with Vagrant + the vmware_desktop plugin on PATH
vagrant up                      # boots actor-a + actor-b (~2 GB each)
pwsh -NoProfile -File .\run-topology.ps1
Get-Content .\receipt.json      # pass == true
vagrant destroy -f              # clean teardown -- no orphaned listeners/locks
```

`run-topology.ps1` exits `0` iff all assertions hold (`pass: true`).

## Notes / gotchas

- **IPs**: the Vagrantfile *requests* `192.168.56.x`, but VMware's host-only DHCP may assign a
  different segment (observed: `192.168.198.135` / `.136`). The driver **discovers the actual
  `192.168.198.*` addresses at runtime**, so the receipt records whatever was assigned.
- **Firewall**: Windows blocks inbound on the private-network profile. The driver adds
  `lbabus-net-tcp` / `lbabus-net-udp` allow rules on the collector before listening.
- **Listener must run in the foreground of `vagrant winrm -c`.** A detached
  `Start-Process` launch fails: WinRM's session-0 has no interactive window station, so the
  listener's `Console.CancelKeyPress` handler throws before it binds. The driver therefore runs
  the collector listener in a host-side `Start-Job` (foreground inside the guest) so the sender
  can fire concurrently.
- The collector's `[net] listen …` / `received N message(s)` lines are written to **stderr**;
  over WinRM PowerShell wraps them as a benign `NativeCommandError`. This is cosmetic — the
  received frames themselves arrive on stdout and are captured verbatim in the receipt.
