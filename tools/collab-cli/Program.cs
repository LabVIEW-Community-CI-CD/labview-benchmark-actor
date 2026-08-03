using System.Globalization;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;
using LabViewBenchmarkActor.CollabBus;

// Windows defaults stdout to the OEM/ANSI codepage, which corrupts multibyte-UTF-8 message
// bodies on write (cafe -> caf?, CJK -> ??). Force UTF-8 (no BOM) so unicode round-trips on
// every plane; a no-op where UTF-8 is already the console encoding (Linux/macOS). Best-effort:
// a redirected or closed console can refuse reconfiguration and must not crash the CLI.
try
{
    Console.OutputEncoding = new UTF8Encoding(encoderShouldEmitUTF8Identifier: false);
}
catch (IOException)
{
    // stdout does not support reconfiguration (e.g. detached) - proceed with the default.
}

return CommandRouter.Run(args);

internal static class CommandRouter
{
    /// <summary>
    /// Flat commands for which <c>--help</c>/<c>-h</c> prints usage instead of running. Sub-dispatched
    /// or passthrough commands (grep/net/resource/agents/docs) own their own help handling.
    /// </summary>
    private static readonly HashSet<string> HelpAwareCommands = new(StringComparer.Ordinal)
    {
        "defect", "selfcheck", "doctor", "preflight", "capabilities", "caps",
    };

    public static int Run(string[] args)
    {
        try
        {
            if (args.Length == 0)
            {
                PrintUsage();
                return 1;
            }

            string command = args[0].ToLowerInvariant();
            var rest = new ArgMap(args.Skip(1));
            string[] tail = args.Skip(1).ToArray();

            // Per-subcommand help: `lbabus <command> --help|-h` prints THAT command's usage and
            // exits 0 instead of falling through to the command itself. Scoped to the flat commands;
            // grep/net/resource/agents/docs own their own arg handling.
            if (HelpAwareCommands.Contains(command) && tail.Any(static t => t is "--help" or "-h"))
            {
                return PrintCommandUsage(command);
            }

            return command switch
            {
                "version" or "--version" or "-v" => CmdVersion(),
                "capabilities" or "caps" => CmdCapabilities(),
                "help" or "--help" or "-h" => PrintUsage(),
                "selfcheck" or "doctor" or "preflight" => CmdSelfCheck(),
                "grep" or "rg" or "search" => CmdGrep(tail),
                "defect" => CmdDefect(rest),
                "net" => NetCommands.Run(tail),
                "resource" or "res" => ResourceCommands.Run(tail),
                "agents" => AgentsCommand.Run(tail),
                "docs" => DocsCommand.Run(tail),
                _ => Fail($"unknown command '{command}'"),
            };
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine("lbabus: " + ex.Message);
            Console.Error.WriteLine("lbabus: if this is a tooling defect, report it: lbabus defect --message \"<symptom, command, expected vs actual>\"");
            return 1;
        }
    }

    private static int CmdVersion()
    {
        Console.WriteLine(CurrentVersion());
        return 0;
    }

    /// <summary>
    /// Prints host capabilities for agent awareness - the pinned toolchain (with detected versions) plus
    /// optional capabilities (Docker, Vagrant, VMware, host LabVIEW). Informational; always exits 0 so an
    /// agent can always query "what can this machine do?" the same way it reads the CLI version.
    /// </summary>
    private static int CmdCapabilities()
    {
        Config cfg = Config.FromEnvironment();
        Console.WriteLine($"lbabus v{CurrentVersion()} - {cfg.Agent} plane on {RuntimeInformation.OSDescription.Trim()} / {RuntimeInformation.OSArchitecture}");
        Console.WriteLine();
        Console.WriteLine("pinned toolchain:");
        foreach (DependencyCheck dc in Preflight.CheckAll())
        {
            string tag = dc.AdvisoryAbsent ? "skip" : dc.Ok ? "ok" : "MISS";
            string ver = dc.Found ? (dc.Parsed?.ToString() ?? dc.RawVersion ?? "?") : "-";
            Console.WriteLine($"  [{tag,4}] {dc.Dep.Command,-7} {"v" + ver,-10} (pin >= v{dc.Dep.MinVersion})");
        }

        Console.WriteLine();
        Console.WriteLine("host capabilities:");
        foreach (HostCapability c in Capabilities.Detect())
        {
            Console.WriteLine($"  [{(c.Available ? "yes" : "no"),3}] {c.Name,-12} {c.Detail}");
        }

        return 0;
    }

    private static int CmdSelfCheck()
    {
        Config cfg = Config.FromEnvironment();
        bool ok = true;

        // Guardrail 1: pinned external dependencies — fail closed if a REQUIRED tool is missing or below its
        // pinned minimum version. Advisory tools (e.g. glab on this GitHub-only repo) are reported but their
        // absence is not fatal; if present they must still meet the pin.
        foreach (DependencyCheck dc in Preflight.CheckAll())
        {
            if (dc.AdvisoryAbsent)
            {
                Console.WriteLine($"[skip] {dc.Dep.Command}: not installed (advisory, pin >= v{dc.Dep.MinVersion})");
            }
            else if (dc.Ok)
            {
                Console.WriteLine($"[ok]   {dc.Dep.Command}: v{dc.Parsed} (pin >= v{dc.Dep.MinVersion})");
            }
            else
            {
                ok = false;
                if (!dc.Found)
                {
                    Console.Error.WriteLine($"[FAIL] {dc.Dep.Command}: not found — required at >= v{dc.Dep.MinVersion}. {dc.Dep.InstallHint}");
                }
                else if (dc.Parsed is null)
                {
                    Console.Error.WriteLine($"[FAIL] {dc.Dep.Command}: version unparseable from \"{dc.RawVersion}\" — required >= v{dc.Dep.MinVersion}.");
                }
                else
                {
                    Console.Error.WriteLine($"[FAIL] {dc.Dep.Command}: v{dc.Parsed} is below the pinned minimum v{dc.Dep.MinVersion}. {dc.Dep.InstallHint}");
                }
            }
        }

        // Guardrail 2: version currency against the latest published release.
        string current = CurrentVersion();
        string? latest;
        try
        {
            using var gh = new GitHubGraphQL();
            latest = LatestPublishedVersion(gh, cfg);
        }
        catch (Exception ex)
        {
            latest = null;
            Console.Error.WriteLine("[warn] could not reach GitHub releases: " + ex.Message);
        }

        bool stale = latest is not null && Version.TryParse(current, out Version? c) && Version.TryParse(latest, out Version? l) && l > c;
        if (latest is null)
        {
            Console.WriteLine($"[warn] version: running v{current}; latest release unknown (offline?)");
        }
        else if (stale)
        {
            ok = false;
            Console.Error.WriteLine($"[FAIL] version: running v{current} but v{latest} is published — rebuild locally:");
            Console.Error.WriteLine(RebuildRecipe(cfg, latest));
        }
        else
        {
            Console.WriteLine($"[ok]   version: v{current} (latest published v{latest})");
        }

        if (ok)
        {
            Console.WriteLine("selfcheck: PASS");
            return 0;
        }

        Console.Error.WriteLine("selfcheck: FAIL");
        return stale ? 3 : 4;
    }

    private static int CmdGrep(string[] tail)
    {
        // Search is ripgrep-only so both planes get identical, deterministic results. No grep/findstr fallback.
        if (tail.Length == 0)
        {
            Console.Error.WriteLine("lbabus grep: pass ripgrep arguments, e.g. `lbabus grep \"pattern\" src`.");
            return 1;
        }

        // Fail closed if ripgrep is missing OR below its pinned minimum version — a too-old rg can diverge
        // in output/flags across planes, defeating the point of a single deterministic search tool.
        DependencyCheck rg = Preflight.Probe(DependencyPolicy.All.First(d => d.Command == "rg"));
        if (!rg.Ok)
        {
            if (!rg.Found)
            {
                Console.Error.WriteLine("lbabus: ripgrep (rg) not found — search in this toolchain is ripgrep-only, no fallback. " + Ripgrep.InstallHint());
            }
            else
            {
                Console.Error.WriteLine($"lbabus: ripgrep v{rg.Parsed?.ToString() ?? rg.RawVersion} is below the pinned minimum v{rg.Dep.MinVersion} — refusing to run. " + Ripgrep.InstallHint());
            }

            return 4;
        }

        return Ripgrep.Run(tail);
    }

    private static int CmdDefect(ArgMap a)
    {
        Config cfg = Config.FromEnvironment();
        string? message = a.Get("message");
        string? messageFile = a.Get("message-file");
        if (message is null && messageFile is not null)
        {
            message = File.ReadAllText(messageFile);
        }

        if (string.IsNullOrWhiteSpace(message))
        {
            return Fail("defect requires --message \"<symptom, command, expected vs actual, workaround>\" or --message-file <f>.");
        }

        int issue = DefectSink.ResolveIssue();
        string ts = DateTimeOffset.UtcNow.ToString("yyyy-MM-ddTHH:mm:ss.fffZ", CultureInfo.InvariantCulture);
        string? title = a.Get("title");
        string body =
            $"### [{cfg.Agent}] tooling defect · {ts}\n\n" +
            (title is null ? string.Empty : $"**{title}**\n\n") +
            message.TrimEnd('\r', '\n') +
            $"\n\n_Reported via `lbabus defect` (v{CurrentVersion()}, {cfg.Agent} plane)._";

        using var gh = new GitHubGraphQL();
        string url = gh.AddIssueComment(cfg, issue, body);
        Console.WriteLine($"defect reported to #{issue}  {url}");
        return 0;
    }

    private static string? LatestPublishedVersion(GitHubGraphQL gh, Config cfg)
    {
        const string prefix = "collab-cli-v";
        Version? best = null;
        string? bestStr = null;
        foreach (string tag in gh.ListReleaseTags(cfg))
        {
            if (!tag.StartsWith(prefix, StringComparison.OrdinalIgnoreCase))
            {
                continue;
            }

            string s = tag[prefix.Length..];
            if (Version.TryParse(s, out Version? v) && (best is null || v > best))
            {
                best = v;
                bestStr = s;
            }
        }

        return bestStr;
    }

    private static string RebuildRecipe(Config cfg, string latest) =>
        $"  git fetch --tags && git checkout collab-cli-v{latest} && cd tools/collab-cli && dotnet build -c Release\n" +
        $"  # or reinstall the pinned global tool from the release nupkg:\n" +
        $"  gh release download collab-cli-v{latest} --repo {cfg.Owner}/{cfg.Repo} --pattern '*.nupkg' --dir <dir> && " +
        $"dotnet tool update --global LabViewBenchmarkActor.CollabBus --version {latest} --add-source <dir>";

    private static string CurrentVersion()
    {
        Assembly asm = typeof(CommandRouter).Assembly;
        string? info = asm.GetCustomAttribute<AssemblyInformationalVersionAttribute>()?.InformationalVersion;
        if (!string.IsNullOrEmpty(info))
        {
            int plus = info.IndexOf('+');
            return plus > 0 ? info[..plus] : info;
        }

        return asm.GetName().Version?.ToString() ?? "0.0.0";
    }

    private static int Fail(string message)
    {
        Console.Error.WriteLine("lbabus: " + message);
        return 1;
    }

    private static int PrintUsage()
    {
        Console.WriteLine(
            """
            lbabus — shared cross-plane coordination bus CLI (labview-benchmark-actor)

            USAGE
              lbabus version
              lbabus capabilities                    # aka caps - pinned toolchain + host capabilities (Docker/Vagrant/VMware/LabVIEW)
              lbabus selfcheck                       # aka doctor/preflight — pinned deps + version current
              lbabus grep <ripgrep args...>          # aka rg/search — ripgrep-only, no fallback
              lbabus defect --message <m> | --message-file <f> [--title <t>]
              lbabus net <listen|send|poll|beacon|ping> ...   # live-only TCP/UDP coordination bus (LBA-REQ-007, ADR-0003/0004)
              lbabus resource <list|status|acquire|release|renew> [name] [--agent <id>] [--ttl <sec>] [--wait [--timeout <sec>]]
              lbabus agents [--out <path> | --check <path>] [--role <name> | --role-from-commit [<ref>] [--repo <dir>]] [--list-roles]
                                                     # emit/verify the version-pinned agent base instructions (+ optional commit-derived role overlay)
              lbabus docs [list | [show] <id>] [--out <path> | --check <path>]
                                                     # emit/verify the version-pinned docs bundle: guide + requirements (srs, rtm)

            AGENT GUARDRAILS (fail-closed)
              * pinned toolchain: `selfcheck`/`doctor`/`preflight` require rg>=13, git>=2.30, gh>=2.20,
                glab>=1.25 — a missing or below-pin tool exits 4 with an install hint.
              * search is ripgrep-only (`lbabus grep`); rg absent or below its pin => exit 4 + install hint.
              * `selfcheck` reports version currency against the latest published release (exit 3 if a newer
                collab-cli-v* is out, exit 4 on a dep miss).
              * report tooling defects via `lbabus defect` to the dedicated log issue
                (LBABUS_DEFECT_ISSUE, default #7).

            CONFIG (env)
              VIHS_COLLAB_OWNER      default LabVIEW-Community-CI-CD
              VIHS_COLLAB_REPO       default labview-benchmark-actor
              VIHS_COLLAB_AGENT      default WIN on Windows, LINUX otherwise
              LBABUS_DEFECT_ISSUE    default #7   (the `lbabus defect` sink)
              LBABUS_GITHUB_API      override the GitHub API base (hermetic CI mock; fail-closed if unreachable)

            AUTH: GH_TOKEN / GITHUB_TOKEN, else `gh auth token`.
            """);
        return 0;
    }

    /// <summary>
    /// Prints the usage for a single subcommand - invoked by <c>lbabus &lt;command&gt; --help|-h</c> -
    /// and returns 0, so probing a flag never runs the command. Falls back to the full usage for a
    /// command without a dedicated line.
    /// </summary>
    private static int PrintCommandUsage(string command)
    {
        string? usage = command switch
        {
            "capabilities" or "caps" =>
                "lbabus capabilities                    # aka caps - pinned toolchain + host capabilities (Docker/Vagrant/VMware/LabVIEW)",
            "selfcheck" or "doctor" or "preflight" =>
                "lbabus selfcheck                       # aka doctor/preflight - pinned deps + version current",
            "defect" => "lbabus defect --message <m> | --message-file <f> [--title <t>]",
            _ => null,
        };

        if (usage is null)
        {
            return PrintUsage();
        }

        Console.WriteLine($"lbabus {command} - usage:");
        Console.WriteLine();
        Console.WriteLine("  " + usage);
        Console.WriteLine();
        Console.WriteLine("Run 'lbabus help' for the full command list and agent guardrails.");
        return 0;
    }
}

/// <summary>Tiny <c>--key value</c> / <c>--flag</c> argument map.</summary>
internal sealed class ArgMap
{
    private readonly Dictionary<string, string> _values = new(StringComparer.OrdinalIgnoreCase);

    public ArgMap(IEnumerable<string> args)
    {
        string[] tokens = args.ToArray();
        for (int i = 0; i < tokens.Length; i++)
        {
            string t = tokens[i];
            if (!t.StartsWith("--", StringComparison.Ordinal))
            {
                continue;
            }

            string key = t[2..];
            if (i + 1 < tokens.Length && !tokens[i + 1].StartsWith("--", StringComparison.Ordinal))
            {
                _values[key] = tokens[++i];
            }
            else
            {
                _values[key] = "true";
            }
        }
    }

    public string? Get(string key) => _values.TryGetValue(key, out string? v) ? v : null;

    public int GetInt(string key, int fallback) =>
        _values.TryGetValue(key, out string? v) && int.TryParse(v, out int n) ? n : fallback;

    public DateTimeOffset? GetTimestamp(string key)
    {
        if (_values.TryGetValue(key, out string? v) &&
            DateTimeOffset.TryParse(v, CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal | DateTimeStyles.AdjustToUniversal, out DateTimeOffset ts))
        {
            return ts;
        }

        return null;
    }
}
