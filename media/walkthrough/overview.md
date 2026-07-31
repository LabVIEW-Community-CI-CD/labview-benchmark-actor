# See a real LabVIEW launch benchmark

The **LabVIEW Benchmark Actor** ships **real, captured** LabVIEW IDE-launch benchmark evidence — measured by watching the IDE come up through a visual capture ring on a clean-room VM.

Everything you see is rendered from data bundled in the extension (no network, no setup):

- how long the IDE took to become **UI-READY** (`launchMs`),
- how that time **trends** across repeated runs,
- how two hypervisor planes (Windows/VMware and Linux/VirtualBox) **compare**,
- and the **CPU / RAM / disk** cost of the launch.

Press **Open Benchmark Trend** on the left to see the launch time across five real runs, with a baseline and a PASS / REGRESSION verdict.
