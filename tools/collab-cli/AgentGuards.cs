using System.Diagnostics;
using System.Runtime.InteropServices;

namespace LabViewBenchmarkActor.CollabBus;

/// <summary>
/// Ripgrep enforcement. Search in this toolchain is ripgrep-only so both planes get identical,
/// fast, deterministic results (grep / findstr / Select-String diverge across OSes — the same
/// class of defect as the old divergent pollers). All entry points fail closed when <c>rg</c>
/// is absent; there is no fallback.
/// </summary>
internal static class Ripgrep
{
    private const string Exe = "rg";

    /// <summary>True if <c>rg</c> is on PATH; <paramref name="version"/> gets its first version line.</summary>
    public static bool TryLocate(out string version)
    {
        version = string.Empty;
        try
        {
            var psi = new ProcessStartInfo(Exe, "--version")
            {
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
            };
            using Process? p = Process.Start(psi);
            if (p is null)
            {
                return false;
            }

            string outText = p.StandardOutput.ReadToEnd();
            p.WaitForExit(10_000);
            if (p.ExitCode != 0)
            {
                return false;
            }

            version = outText.Replace("\r", string.Empty).Split('\n').FirstOrDefault()?.Trim() ?? string.Empty;
            return true;
        }
        catch
        {
            return false;
        }
    }

    /// <summary>Runs <c>rg</c> with the given args (stdio inherited). Fails closed (exit 4) when absent.</summary>
    public static int Run(IReadOnlyList<string> args)
    {
        try
        {
            var psi = new ProcessStartInfo(Exe) { UseShellExecute = false };
            foreach (string a in DeterministicArgs(args))
            {
                psi.ArgumentList.Add(a);
            }

            using Process? p = Process.Start(psi);
            if (p is null)
            {
                Console.Error.WriteLine("lbabus: failed to start ripgrep.");
                return 127;
            }

            p.WaitForExit();
            return p.ExitCode;
        }
        catch (System.ComponentModel.Win32Exception)
        {
            Console.Error.WriteLine("lbabus: ripgrep (rg) not found — search in this toolchain is ripgrep-only, no fallback. " + InstallHint());
            return 4;
        }
    }

    /// <summary>
    /// Prepends TTY-independent defaults (<c>--color=never --no-heading</c>) so <c>lbabus grep</c> emits
    /// byte-identical output whether stdout is a terminal or a pipe — ripgrep otherwise auto-enables ANSI
    /// colour and filename grouping on a TTY, which diverges across planes and breaks the CI harness's
    /// output comparison. ripgrep is last-wins, so a caller can still override (e.g. <c>--color=always</c>).
    /// </summary>
    internal static IReadOnlyList<string> DeterministicArgs(IReadOnlyList<string> args)
    {
        var result = new List<string>(args.Count + 2) { "--color=never", "--no-heading" };
        result.AddRange(args);
        return result;
    }

    public static string InstallHint()
    {
        if (RuntimeInformation.IsOSPlatform(OSPlatform.Windows))
        {
            return "Install: winget install BurntSushi.ripgrep.MSVC";
        }

        if (RuntimeInformation.IsOSPlatform(OSPlatform.OSX))
        {
            return "Install: brew install ripgrep";
        }

        return "Install: apt-get install ripgrep (or your distro's package manager).";
    }
}

/// <summary>Defaults for the sanctioned tooling-defect reporting sink.</summary>
internal static class DefectSink
{
    /// <summary>Dedicated tooling defect-log issue in the coordination repo.</summary>
    public const int DefaultIssue = 7;

    public static int ResolveIssue()
    {
        string? env = Environment.GetEnvironmentVariable("LBABUS_DEFECT_ISSUE");
        return int.TryParse(env, out int n) && n > 0 ? n : DefaultIssue;
    }
}
