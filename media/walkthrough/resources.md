# The resource cost of a launch

**Open Benchmark Resource Profile** shows CPU / RAM / disk sampled **live** inside the VM during the launch, correlated to the capture timeline and split at the **UI-READY trigger** (the red line): *pre* = while launching, *post* = once settled.

The headline is RAM: launching the IDE costs **~+116 MB resident**.

**Open Cross-Plane Resource Agreement** compares the two hypervisor planes. The finding: both planes load LabVIEW's resident memory to **within ~1 MB of each other** — a substrate-independent signal, while the timing is the substrate-dependent part.
