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
        "post", "poll", "wait", "defect", "delta", "init",
        "selfcheck", "doctor", "preflight", "capabilities", "caps",
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
            // exits 0 instead of falling through to the command itself. Falling through is a
            // footgun: `wait --help` used to start a real blocking wait, `poll --help` dumped the
            // tail, and `post --help` posted an empty NOTE to the discussion. Scoped to the flat
            // commands; grep/net/resource/agents/docs own their own arg handling.
            if (HelpAwareCommands.Contains(command) && tail.Any(static t => t is "--help" or "-h"))
            {
                return PrintCommandUsage(command);
            }

            return command switch
            {
                "version" or "--version" or "-v" => CmdVersion(),
                "capabilities" or "caps" => CmdCapabilities(),
                "help" or "--help" or "-h" => PrintUsage(),
                "init" => CmdInit(),
                "post" => CmdPost(rest),
                "poll" => CmdPoll(rest),
                "wait" => CmdWait(rest),
                "selfcheck" or "doctor" or "preflight" => CmdSelfCheck(),
                "grep" or "rg" or "search" => CmdGrep(tail),
                "defect" => CmdDefect(rest),
                "delta" => CmdDelta(rest),
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

    private static int CmdInit()
    {
        Config cfg = Config.FromEnvironment();
        using var gh = new GitHubGraphQL();
        string seed = SeedBody(cfg);
        DiscussionRef disc = gh.EnsureDiscussion(cfg, seed);
        Console.WriteLine($"discussion #{disc.Number}  {disc.Url}");
        return 0;
    }

    private static int CmdPost(ArgMap a)
    {
        Config cfg = Config.FromEnvironment();
        string type = (a.Get("type") ?? "NOTE").ToUpperInvariant();
        if (!CollabMessage.Types.Contains(type))
        {
            return Fail($"invalid --type '{type}'. Valid: {string.Join(", ", CollabMessage.Types)}");
        }

        string? message = a.Get("message");
        string? messageFile = a.Get("message-file");
        if (message is null && messageFile is not null)
        {
            message = File.ReadAllText(messageFile);
        }

        string? priorityArg = a.Get("priority");
        string? prio = null;
        if (priorityArg is not null)
        {
            prio = Priority.TryNormalize(priorityArg);
            if (prio is null)
            {
                return Fail($"invalid --priority '{priorityArg}'. Valid: {string.Join(", ", Priority.Tiers)} (default {Priority.Default}).");
            }
        }

        var msg = new CollabMessage
        {
            Agent = cfg.Agent,
            AgentId = cfg.AgentId,
            Ts = DateTimeOffset.UtcNow.ToString("yyyy-MM-ddTHH:mm:ss.fffZ", CultureInfo.InvariantCulture),
            Type = type,
            Task = a.Get("task"),
            Msg = message?.TrimEnd('\r', '\n'),
            Ref = a.Get("ref"),
            Next = a.Get("next"),
            To = a.Get("to"),
            Prio = prio,
        };

        using var gh = new GitHubGraphQL();
        int? staleExit = EnforceVersionOrNull(gh, cfg);
        if (staleExit is not null)
        {
            return staleExit.Value;
        }

        DiscussionRef disc = gh.EnsureDiscussion(cfg, SeedBody(cfg));

        // CHECK-BEFORE-PUBLISH: surface any counterpart messages posted since this agent's last post.
        IReadOnlyList<DiscussionComment> recent = gh.ListComments(cfg, disc.Number, 30);
        List<CollabMessage> parsed = ParseAll(recent);
        DateTimeOffset? myLast = parsed.Where(m => Eq(m.Agent, cfg.Agent)).Select(m => m.CreatedAt).LastOrDefault();
        List<CollabMessage> sinceMine = parsed
            .Where(m => Eq(m.Agent, cfg.Counterpart) && (myLast is null || m.CreatedAt > myLast))
            .ToList();
        if (sinceMine.Count > 0)
        {
            Console.Error.WriteLine($"lbabus: NOTE — {cfg.Counterpart} posted {sinceMine.Count} message(s) since your last; confirm this post accounts for them:");
            foreach (CollabMessage m in sinceMine)
            {
                Console.Error.WriteLine("  " + m.ToLine());
            }
        }

        string url = gh.AddComment(disc.Id, msg.ToBody());
        Console.WriteLine($"posted {type}  {url}");
        return 0;
    }

    private static int CmdPoll(ArgMap a)
    {
        Config cfg = Config.FromEnvironment();
        int tail = a.GetInt("tail", 10);
        string? agent = a.Get("agent");
        string? type = a.Get("type");
        DateTimeOffset? since = a.GetTimestamp("since");
        bool full = a.Get("full") is not null;
        bool toMe = a.Get("to-me") is not null;
        string? minPrio = a.Get("min-priority");
        if (minPrio is not null && Priority.TryNormalize(minPrio) is null)
        {
            return Fail($"invalid --min-priority '{minPrio}'. Valid: {string.Join(", ", Priority.Tiers)}.");
        }

        using var gh = new GitHubGraphQL();
        DiscussionRef? disc = gh.FindDiscussion(cfg);
        if (disc is null)
        {
            Console.Error.WriteLine("lbabus: bus discussion not found (run `lbabus init`).");
            return 2;
        }

        List<CollabMessage> messages = ParseAll(gh.ListComments(cfg, disc.Number, Math.Max(tail, 50)))
            .Where(m => agent is null || Eq(m.Agent, agent))
            .Where(m => type is null || Eq(m.Type, type))
            .Where(m => since is null || m.CreatedAt > since)
            .Where(m => !toMe || cfg.AddressesMe(m.To))
            .Where(m => minPrio is null || Priority.MeetsThreshold(m.Prio, minPrio))
            .ToList();

        Console.WriteLine($"# {disc.Url}  ({messages.Count} message(s))");
        foreach (CollabMessage m in messages.TakeLast(tail))
        {
            Console.WriteLine(full ? m.ToFull() : m.ToLine());
        }

        return 0;
    }

    private static int CmdWait(ArgMap a)
    {
        Config cfg = Config.FromEnvironment();
        string target = (a.Get("agent") ?? cfg.Counterpart).ToUpperInvariant();
        DateTimeOffset? explicitSince = a.GetTimestamp("since");
        int timeoutSec = a.GetInt("timeout", 1800);
        int intervalSec = Math.Max(a.GetInt("interval", 20), 5);
        bool toMe = a.Get("to-me") is not null;
        string? minPrio = a.Get("min-priority");
        if (minPrio is not null && Priority.TryNormalize(minPrio) is null)
        {
            return Fail($"invalid --min-priority '{minPrio}'. Valid: {string.Join(", ", Priority.Tiers)}.");
        }

        using var gh = new GitHubGraphQL();
        int? staleExit = EnforceVersionOrNull(gh, cfg);
        if (staleExit is not null)
        {
            return staleExit.Value;
        }

        DiscussionRef? disc = gh.FindDiscussion(cfg);
        if (disc is null)
        {
            Console.Error.WriteLine("lbabus: bus discussion not found (run `lbabus init`).");
            return 2;
        }

        // Baseline for "new" target messages. Two modes:
        //   - explicit --since T: a raw timestamp filter, STRICTLY after T (backward-compat).
        //   - default (no --since): cursor from the reader's OWN last message -- "catch me up on <target>
        //     since I last spoke" (same semantic as post's check-before-publish). Anchoring on the reader's
        //     last message AND excluding it by its comment ID (issue #100) means a target message in the SAME
        //     whole second as the reader's last post is still surfaced -- GitHub createdAt is second-granular,
        //     so a strict timestamp compare silently drops same-second messages. Falls back to the latest
        //     comment when the reader has not posted yet (nothing to catch up on).
        DateTimeOffset since;
        string? baselineId = null;
        bool inclusive;
        if (explicitSince is { } es)
        {
            since = es;
            inclusive = false;
        }
        else
        {
            List<CollabMessage> existing = ParseAll(gh.ListComments(cfg, disc.Number, 50));
            CollabMessage? readerLast = existing.LastOrDefault(m => Eq(m.Agent, cfg.Agent));
            if (readerLast?.CreatedAt is { } mine)
            {
                since = mine;
                baselineId = readerLast.CommentId;
            }
            else
            {
                since = existing.Select(m => m.CreatedAt).OfType<DateTimeOffset>().DefaultIfEmpty(DateTimeOffset.UtcNow).Max();
            }

            inclusive = true;
        }

        DateTimeOffset deadline = DateTimeOffset.UtcNow.AddSeconds(timeoutSec);
        Console.Error.WriteLine($"[wait] {target} after {since:yyyy-MM-ddTHH:mm:ss.fffZ} on {disc.Url} (timeout {timeoutSec}s)");

        int poll = 0;
        while (true)
        {
            poll++;

            // Re-check version currency EACH iteration: `wait` is long-lived, so a release can be
            // published mid-loop (the norm in our workflow). The start-only check cannot see it.
            // On a newer release, fail closed and force a restart with the updated CLI (fail-open on
            // network error so a transient blip does not kill an otherwise-valid waiter).
            int? staleMidLoop = EnforceVersionOrNull(gh, cfg);
            if (staleMidLoop is not null)
            {
                Console.Error.WriteLine($"[wait] a newer release was published mid-wait (after {poll} poll(s)) — STOP and restart the loop with the updated CLI.");
                return staleMidLoop.Value;
            }

            List<CollabMessage> hits = ParseAll(gh.ListComments(cfg, disc.Number, 50))
                .Where(m => Eq(m.Agent, target) && m.CreatedAt is { } c
                    && (inclusive ? c >= since : c > since)
                    && (baselineId is null || m.CommentId != baselineId))
                .Where(m => !toMe || cfg.AddressesMe(m.To))
                .Where(m => minPrio is null || Priority.MeetsThreshold(m.Prio, minPrio))
                .OrderBy(m => m.CreatedAt)
                .ToList();

            if (hits.Count > 0)
            {
                foreach (CollabMessage m in hits)
                {
                    Console.WriteLine(m.ToLine());
                }

                return 0;
            }

            if (DateTimeOffset.UtcNow >= deadline)
            {
                Console.Error.WriteLine($"[wait] no {target} reply within {timeoutSec}s ({poll} polls).");
                return 2;
            }

            Console.Error.WriteLine($"[wait] poll {poll}: no new {target}; sleeping {intervalSec}s");
            Thread.Sleep(TimeSpan.FromSeconds(intervalSec));
        }
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

    /// <summary>
    /// Version-currency guardrail for the coordination-critical commands: if a newer
    /// <c>collab-cli-v*</c> release is published, refuse to touch the bus and force a local rebuild.
    /// Returns null when current (or unreachable/offline, or bypassed) — otherwise the exit code to return.
    /// </summary>
    private static int? EnforceVersionOrNull(GitHubGraphQL gh, Config cfg)
    {
        if (!string.IsNullOrEmpty(Environment.GetEnvironmentVariable("LBABUS_SKIP_VERSION_CHECK")))
        {
            return null;
        }

        string current = CurrentVersion();
        string? latest;
        try
        {
            latest = LatestPublishedVersion(gh, cfg);
        }
        catch
        {
            // When LBABUS_GITHUB_API is pinned (hermetic CI), an unreachable endpoint is a hard
            // misconfiguration — fail closed rather than silently proceeding as if offline.
            if (GitHubGraphQL.ApiOverridden)
            {
                Console.Error.WriteLine(
                    $"lbabus: LBABUS_GITHUB_API={GitHubGraphQL.ApiBase} is set but the release lookup failed — refusing to proceed (fail-closed).");
                return 3;
            }

            // Otherwise fail open on network/release-lookup errors so an offline plane is not wedged.
            return null;
        }

        if (latest is not null && Version.TryParse(current, out Version? c) && Version.TryParse(latest, out Version? l) && l > c)
        {
            Console.Error.WriteLine($"lbabus: STALE — running v{current} but v{latest} is published. Rebuild locally before using the bus:");
            Console.Error.WriteLine(RebuildRecipe(cfg, latest));
            Console.Error.WriteLine("(bypass for offline/dev with LBABUS_SKIP_VERSION_CHECK=1)");
            return 3;
        }

        return null;
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

    private static int CmdDelta(ArgMap a)
    {
        Config cfg = Config.FromEnvironment();
        string target = (a.Get("agent") ?? cfg.Counterpart).ToUpperInvariant();
        int tail = a.GetInt("tail", 5);
        DateTimeOffset? since = a.GetTimestamp("since");

        using var gh = new GitHubGraphQL();
        DiscussionRef? disc = gh.FindDiscussion(cfg);
        if (disc is null)
        {
            Console.Error.WriteLine("lbabus: bus discussion not found (run `lbabus init`).");
            return 2;
        }

        // All parsed messages in chronological order (server createdAt).
        List<CollabMessage> all = ParseAll(gh.ListComments(cfg, disc.Number, Math.Max(tail * 6, 60)));

        var rows = new List<string>();
        for (int i = 0; i < all.Count; i++)
        {
            CollabMessage m = all[i];
            if (!Eq(m.Agent, target))
            {
                continue;
            }

            if (since is not null && m.CreatedAt <= since)
            {
                continue;
            }

            // gap: previous message from the same agent before m.
            CollabMessage? prevSame = null;
            // latency trigger: most recent message from a DIFFERENT agent before m.
            CollabMessage? trigger = null;
            for (int j = i - 1; j >= 0; j--)
            {
                if (prevSame is null && Eq(all[j].Agent, target))
                {
                    prevSame = all[j];
                }

                if (trigger is null && !Eq(all[j].Agent, target))
                {
                    trigger = all[j];
                }

                if (prevSame is not null && trigger is not null)
                {
                    break;
                }
            }

            string gap = prevSame is null ? "n/a" : "+" + Dur((m.CreatedAt - prevSame.CreatedAt).GetValueOrDefault());
            string latency = trigger is null
                ? "n/a"
                : $"{Dur((m.CreatedAt - trigger.CreatedAt).GetValueOrDefault())} (trigger: {trigger.Agent} {trigger.Type} {trigger.CreatedAt:yyyy-MM-ddTHH:mm:ss.fffZ})";

            rows.Add($"{m.CreatedAt:yyyy-MM-ddTHH:mm:ss.fffZ}  {m.Type}/{m.Task ?? "-"}  gap={gap}  latency={latency}");
        }

        Console.WriteLine($"# response deltas: {target} on {disc.Url}  ({rows.Count} response(s))");
        foreach (string row in rows.TakeLast(tail))
        {
            Console.WriteLine(row);
        }

        return 0;
    }

    private static List<CollabMessage> ParseAll(IReadOnlyList<DiscussionComment> comments)
    {
        var list = new List<CollabMessage>();
        foreach (DiscussionComment c in comments)
        {
            CollabMessage? m = CollabMessage.TryParse(c.Body, c.CreatedAt, c.Id);
            if (m is not null)
            {
                list.Add(m);
            }
        }

        return list.OrderBy(m => m.CreatedAt).ToList();
    }

    private static string SeedBody(Config cfg) =>
        $"Coordination + handshake bus between the WIN and LINUX planes for {cfg.Owner}/{cfg.Repo}.\n\n" +
        "Each comment is a structured `vihs-collab-msg@v1` message posted via the shared `lbabus` CLI " +
        "(`lbabus post|poll|wait`). One versioned binary, one deterministic protocol.";

    private static bool Eq(string? a, string? b) => string.Equals(a, b, StringComparison.OrdinalIgnoreCase);

    private static string Dur(TimeSpan t)
    {
        double sec = Math.Abs(t.TotalSeconds);
        if (sec >= 3600)
        {
            int h = (int)(sec / 3600);
            int m = (int)(sec % 3600 / 60);
            int s = (int)(sec % 60);
            return $"{h}h{m:00}m{s:00}s";
        }

        if (sec >= 60)
        {
            int m = (int)(sec / 60);
            double s = sec - (m * 60);
            return $"{m}m{s:00.0}s";
        }

        return $"{sec:0.0}s";
    }

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
              lbabus init
              lbabus post --type <T> [--task <id>] [--message <m> | --message-file <f>] [--ref <sha>] [--next <n>] [--to <A>] [--priority P0|P1|P2|P3]
              lbabus poll [--tail <N>] [--agent <A>] [--type <T>] [--since <iso>] [--full] [--to-me] [--min-priority P0|P1|P2|P3]
              lbabus wait [--agent LINUX|WIN] [--since <iso>] [--timeout <sec>] [--interval <sec>] [--to-me] [--min-priority P0|P1|P2|P3]
              lbabus selfcheck                       # aka doctor/preflight — pinned deps + version current
              lbabus grep <ripgrep args...>          # aka rg/search — ripgrep-only, no fallback
              lbabus defect --message <m> | --message-file <f> [--title <t>]
              lbabus delta [--agent <A>] [--tail <N>] [--since <iso>]   # CLI-measured response deltas (symmetric)
              lbabus net <listen|send|beacon|ping> ...   # local TCP/UDP coordination bus (LBA-REQ-007, ADR-0003/0004)
              lbabus resource <list|status|acquire|release|renew> [name] [--agent <id>] [--ttl <sec>] [--wait [--timeout <sec>]]
              lbabus agents [--out <path> | --check <path>] [--role <name> | --role-from-commit [<ref>] [--repo <dir>]] [--list-roles]
                                                     # emit/verify the version-pinned agent base instructions (+ optional commit-derived role overlay)
              lbabus docs [--out <path> | --check <path>]     # emit/verify the version-pinned documentation package

            AGENT GUARDRAILS (fail-closed)
              * pinned toolchain: `selfcheck`/`doctor`/`preflight` require rg>=13, git>=2.30, gh>=2.20,
                glab>=1.25 — a missing or below-pin tool exits 4 with an install hint.
              * search is ripgrep-only (`lbabus grep`); rg absent or below its pin => exit 4 + install hint.
              * `post`/`wait` refuse to run when a newer collab-cli-v* release is published (exit 3);
                bypass offline/dev with LBABUS_SKIP_VERSION_CHECK=1.
              * report tooling defects via `lbabus defect` to the dedicated log issue
                (LBABUS_DEFECT_ISSUE, default #7).

            CONFIG (env)
              VIHS_COLLAB_OWNER      default LabVIEW-Community-CI-CD
              VIHS_COLLAB_REPO       default labview-benchmark-actor
              VIHS_COLLAB_CATEGORY   default General
              VIHS_COLLAB_TITLE      default 'labview-benchmark-actor coordination bus (WIN <-> LINUX)'
              VIHS_COLLAB_AGENT      default WIN on Windows, LINUX otherwise
              VIHS_COLLAB_AGENT_ID   default = plane label; a finer per-plane agent id for --to / --to-me
              LBABUS_DEFECT_ISSUE    default #7   LBABUS_SKIP_VERSION_CHECK   bypass version guard
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
            "init" => "lbabus init",
            "post" =>
                "lbabus post --type <T> [--task <id>] [--message <m> | --message-file <f>] [--ref <sha>] [--next <n>] [--to <A>] [--priority P0|P1|P2|P3]",
            "poll" =>
                "lbabus poll [--tail <N>] [--agent <A>] [--type <T>] [--since <iso>] [--full] [--to-me] [--min-priority P0|P1|P2|P3]",
            "wait" =>
                "lbabus wait [--agent LINUX|WIN] [--since <iso>] [--timeout <sec>] [--interval <sec>] [--to-me] [--min-priority P0|P1|P2|P3]",
            "selfcheck" or "doctor" or "preflight" =>
                "lbabus selfcheck                       # aka doctor/preflight - pinned deps + version current",
            "defect" => "lbabus defect --message <m> | --message-file <f> [--title <t>]",
            "delta" =>
                "lbabus delta [--agent <A>] [--tail <N>] [--since <iso>]   # CLI-measured response deltas (symmetric)",
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
