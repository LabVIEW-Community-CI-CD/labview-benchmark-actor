# Golden Actor Activation Runbook

This runbook prepares a local Ubuntu golden actor for the human-only LabVIEW Community Edition activation step.

## Boundary

Automation may install public packages, configure headless prerequisites, collect non-secret readiness evidence, and run a functional known-answer probe. It must never accept, request, read, or transmit an NI account password, MFA code, or VIPM credential.

## Agent Cycle

From the repository root, use a declared mesh actor as the temporary golden activation target:

```powershell
pwsh -File cleanroom/ubuntu-labview/golden-activation-cycle.ps1 -Vm actor1 -Mode Check
pwsh -File cleanroom/ubuntu-labview/golden-activation-cycle.ps1 -Vm actor1 -Mode Repair
pwsh -File cleanroom/ubuntu-labview/golden-activation-cycle.ps1 -Vm actor1 -Mode Handoff
```

`Check` writes a non-secret readiness capture and receipt. `Repair` reruns the public dependency provisioner, reboots once for VI Server readiness, and checks again. `Handoff` is available only after readiness is confirmed.

## User Handoff

Open the actor's VMware console, launch LabVIEW Community Edition, and complete NI/VIPM activation directly in the VM. Credentials and MFA codes stay in the user-controlled console.

After activation, the agent can verify it functionally:

```powershell
pwsh -File cleanroom/ubuntu-labview/golden-activation-cycle.ps1 -Vm actor1 -Mode Confirm
```

A successful confirmation writes `golden-actor1-activation-receipt.json` under `mesh/.vagrant/`. Only a receipt with `verdict.activated: true` may be passed to the actor enrollment workflow.

## Handoff Evidence

The activation cycle keeps these non-secret local artifacts in `mesh/.vagrant/`:

- `golden-actor1-readiness-capture.json`
- `golden-actor1-readiness-receipt.json`
- `golden-actor1-activation-capture.json`
- `golden-actor1-activation-receipt.json`

A `-350000` result is an unconfirmed activation/VI Server probe result, not permission for automation to retry credentials. Reissue the human handoff, then use `Confirm` after the user completes activation.
