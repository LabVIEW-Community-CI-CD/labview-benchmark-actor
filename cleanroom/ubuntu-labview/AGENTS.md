# Ubuntu Golden Actor Agent Runbook

Use this folder only for public dependency repair and non-secret readiness work. LabVIEW and VIPM activation always belong to the user in the VM console.

1. Start with `golden-activation-cycle.ps1 -Vm <actor> -Mode Check`.
2. If the receipt is incomplete, use `-Mode Repair`; it may install public packages and reboot the actor once.
3. When readiness is confirmed, use `-Mode Handoff` and stop at the user interaction boundary.
4. After the user activates LabVIEW, use `-Mode Confirm`; only an `activation-receipt@1` with `verdict.activated: true` permits golden actor enrollment.
5. Do not ask for or route passwords, MFA codes, tokens, or license keys through chat, environment variables, arguments, or uploaded files.

For mesh lifecycle work, use `mesh/provision-cycle.ps1 -Plan` before `-Apply` or `-Replace`, and verify the local receipt before reusing existing actors.
