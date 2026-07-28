using System.Diagnostics;
using System.Text.RegularExpressions;

namespace LabViewBenchmarkActor.CollabBus;

/// <summary>
/// An external command-line tool the coordination toolchain depends on, pinned to a MINIMUM version.
/// Minimums (not exact pins) are deliberate: the two planes drift on patch/minor (e.g. ripgrep 15.2 on
/// Windows vs 15.1 on Linux), so an exact pin would fail one plane. A tool below its pin — or, when
/// <see cref="Required"/>, missing entirely — makes the preflight fail closed.
/// </summary>
internal sealed record PinnedDependency(
    string Command,
    string[] ProbeArgs,
    string VersionPattern,
    string MinVersion,
    string InstallHint,
    bool Required = true);

/// <summary>Result of probing one <see cref="PinnedDependency"/>.</summary>
internal sealed record DependencyCheck(PinnedDependency Dep, bool Found, string? RawVersion, Version? Parsed, bool MeetsPin)
{
    /// <summary>
    /// A required tool must be present AND meet its pin. An advisory (non-required) tool is allowed to be
    /// absent, but if it IS present it must still meet the pin (a present-but-stale pinned tool is a hazard).
    /// </summary>
    public bool Ok => Dep.Required ? Found && MeetsPin : (!Found || MeetsPin);

    /// <summary>True when an advisory tool is simply absent (reported, not a failure).</summary>
    public bool AdvisoryAbsent => !Dep.Required && !Found;
}

/// <summary>The pinned-dependency policy for the coordination toolchain. Single source of truth.</summary>
internal static class DependencyPolicy
{
    // ripgrep/git/gh/glab are all required by the cross-plane coordination workflow: ripgrep (deterministic
    // search), git (branch/PR flow + token-injected GitLab pulls of mprr), gh (GitHub PRs/releases/issues),
    // and glab (GitLab CLI). Every plane must have the pinned toolchain installed or the preflight fails closed.
    public static readonly IReadOnlyList<PinnedDependency> All = new[]
    {
        new PinnedDependency("rg", new[] { "--version" }, @"ripgrep\s+(\d+\.\d+(?:\.\d+)?)", "13.0.0",
            "winget install BurntSushi.ripgrep.MSVC  |  apt-get install ripgrep  |  brew install ripgrep"),
        new PinnedDependency("git", new[] { "--version" }, @"git version\s+(\d+\.\d+(?:\.\d+)?)", "2.30.0",
            "https://git-scm.com/downloads"),
        new PinnedDependency("gh", new[] { "--version" }, @"gh version\s+(\d+\.\d+(?:\.\d+)?)", "2.20.0",
            "https://github.com/cli/cli#installation"),
        new PinnedDependency("glab", new[] { "--version" }, @"glab\s+(\d+\.\d+(?:\.\d+)?)", "1.25.0",
            "winget install GLab.GLab  |  https://gitlab.com/gitlab-org/cli#installation"),
    };
}

/// <summary>Runs the pinned-dependency preflight. Pure probing; no network, no shell.</summary>
internal static class Preflight
{
    public static IReadOnlyList<DependencyCheck> CheckAll() => DependencyPolicy.All.Select(Probe).ToList();

    public static DependencyCheck Probe(PinnedDependency dep)
    {
        if (!Version.TryParse(Normalize(dep.MinVersion), out Version? min))
        {
            min = new Version(0, 0, 0);
        }

        string? raw = TryGetVersionOutput(dep);
        if (raw is null)
        {
            return new DependencyCheck(dep, Found: false, RawVersion: null, Parsed: null, MeetsPin: false);
        }

        Match m = Regex.Match(raw, dep.VersionPattern);
        if (!m.Success || !Version.TryParse(Normalize(m.Groups[1].Value), out Version? parsed))
        {
            // Present but the version could not be parsed — treat as not meeting the pin (fail closed).
            return new DependencyCheck(dep, Found: true, RawVersion: raw.Trim(), Parsed: null, MeetsPin: false);
        }

        return new DependencyCheck(dep, Found: true, RawVersion: raw.Trim(), Parsed: parsed, MeetsPin: parsed >= min);
    }

    private static string? TryGetVersionOutput(PinnedDependency dep)
    {
        try
        {
            var psi = new ProcessStartInfo(dep.Command)
            {
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
            };
            foreach (string a in dep.ProbeArgs)
            {
                psi.ArgumentList.Add(a);
            }

            using Process? p = Process.Start(psi);
            if (p is null)
            {
                return null;
            }

            string outText = p.StandardOutput.ReadToEnd();
            string errText = p.StandardError.ReadToEnd();
            p.WaitForExit(10_000);
            string combined = (string.IsNullOrWhiteSpace(outText) ? errText : outText);
            return string.IsNullOrWhiteSpace(combined) ? null : combined.Replace("\r", string.Empty).Split('\n').FirstOrDefault();
        }
        catch (System.ComponentModel.Win32Exception)
        {
            // Command not found on PATH.
            return null;
        }
        catch
        {
            return null;
        }
    }

    /// <summary>Pad a dotted version to at least major.minor.build so 2-part and 3-part pins compare correctly.</summary>
    private static string Normalize(string v)
    {
        string[] parts = v.Trim().Split('.');
        int major = parts.Length > 0 && int.TryParse(parts[0], out int a) ? a : 0;
        int minor = parts.Length > 1 && int.TryParse(parts[1], out int b) ? b : 0;
        int build = parts.Length > 2 && int.TryParse(parts[2], out int c) ? c : 0;
        return $"{major}.{minor}.{build}";
    }
}
