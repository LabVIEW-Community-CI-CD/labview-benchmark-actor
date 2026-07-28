using System.Diagnostics;
using System.Runtime.InteropServices;

namespace LabViewBenchmarkActor.CollabBus;

/// <summary>One optional host capability the agent can be aware of (e.g. Docker, Vagrant, VMware).</summary>
internal sealed record HostCapability(string Name, bool Available, string Detail);

/// <summary>
/// Detects optional host capabilities beyond the pinned toolchain, so an agent can print — alongside the
/// CLI version — what this machine can actually do (run containers, drive VMs, provision a clean room).
/// Purely informational: nothing here fails closed.
/// </summary>
internal static class Capabilities
{
    public static IReadOnlyList<HostCapability> Detect() => new[]
    {
        ProbeDocker(),
        ProbeVagrant(),
        ProbeVmware(),
        ProbeLabViewCli(),
    };

    private static HostCapability ProbeDocker()
    {
        (int? code, string outText) = Run("docker", "version", "--format", "{{.Server.Os}}/{{.Server.Arch}}");
        if (code is null)
        {
            return new HostCapability("docker", false, "not installed");
        }

        if (code == 0 && outText.Length > 0)
        {
            return new HostCapability("docker", true, $"{outText} engine — containers available");
        }

        return new HostCapability("docker", false, "installed, daemon not reachable");
    }

    private static HostCapability ProbeVagrant()
    {
        (int? code, string outText) = Run("vagrant", "--version");
        return code == 0 && outText.Length > 0
            ? new HostCapability("vagrant", true, outText.Trim())
            : new HostCapability("vagrant", false, "not installed");
    }

    private static HostCapability ProbeVmware()
    {
        string? vmrun = LocateVmrun();
        if (vmrun is null)
        {
            return new HostCapability("vmware", false, "vmrun not found");
        }

        (int? code, string outText) = Run(vmrun, "list");
        string running = code == 0 && outText.Length > 0 ? outText.Split('\n')[0].Trim() : "vmrun present";
        return new HostCapability("vmware", true, $"{vmrun} — {running}");
    }

    private static HostCapability ProbeLabViewCli()
    {
        (int? code, _) = Run("LabVIEWCLI", "-Help");
        return code is not null
            ? new HostCapability("labview-cli", true, "LabVIEWCLI on PATH (host-native)")
            : new HostCapability("labview-cli", false, "not on PATH (clean-room VM only)");
    }

    private static string? LocateVmrun()
    {
        var candidates = new List<string>();
        if (RuntimeInformation.IsOSPlatform(OSPlatform.Windows))
        {
            string pf = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles);
            string pf86 = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86);
            candidates.Add(Path.Combine(pf, "VMware", "VMware Workstation", "vmrun.exe"));
            candidates.Add(Path.Combine(pf86, "VMware", "VMware Workstation", "vmrun.exe"));
            candidates.Add(Path.Combine(pf, "VMware", "VMware Player", "vmrun.exe"));
        }
        else
        {
            candidates.Add("/usr/bin/vmrun");
            candidates.Add("/Applications/VMware Fusion.app/Contents/Library/vmrun");
        }

        return candidates.FirstOrDefault(File.Exists);
    }

    private static (int? ExitCode, string Output) Run(string command, params string[] args)
    {
        try
        {
            var psi = new ProcessStartInfo(command)
            {
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
            };
            foreach (string a in args)
            {
                psi.ArgumentList.Add(a);
            }

            using Process? p = Process.Start(psi);
            if (p is null)
            {
                return (null, string.Empty);
            }

            string outText = p.StandardOutput.ReadToEnd();
            string errText = p.StandardError.ReadToEnd();
            p.WaitForExit(10_000);
            string combined = string.IsNullOrWhiteSpace(outText) ? errText : outText;
            return (p.ExitCode, combined.Replace("\r", string.Empty).Trim());
        }
        catch (System.ComponentModel.Win32Exception)
        {
            return (null, string.Empty);
        }
        catch
        {
            return (null, string.Empty);
        }
    }
}
