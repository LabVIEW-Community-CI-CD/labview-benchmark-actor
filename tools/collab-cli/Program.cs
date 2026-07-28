using System.Globalization;
using System.Reflection;
using LabViewBenchmarkActor.CollabBus;

return CommandRouter.Run(args);

internal static class CommandRouter
{
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

            return command switch
            {
                "version" or "--version" or "-v" => CmdVersion(),
                "help" or "--help" or "-h" => PrintUsage(),
                "init" => CmdInit(),
                "post" => CmdPost(rest),
                "poll" => CmdPoll(rest),
                "wait" => CmdWait(rest),
                _ => Fail($"unknown command '{command}'"),
            };
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine("lbabus: " + ex.Message);
            return 1;
        }
    }

    private static int CmdVersion()
    {
        Console.WriteLine(CurrentVersion());
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

        var msg = new CollabMessage
        {
            Agent = cfg.Agent,
            Ts = DateTimeOffset.UtcNow.ToString("yyyy-MM-ddTHH:mm:ss.fffZ", CultureInfo.InvariantCulture),
            Type = type,
            Task = a.Get("task"),
            Msg = message?.TrimEnd('\r', '\n'),
            Ref = a.Get("ref"),
            Next = a.Get("next"),
            To = a.Get("to"),
        };

        using var gh = new GitHubGraphQL();
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
            .ToList();

        Console.WriteLine($"# {disc.Url}  ({messages.Count} message(s))");
        foreach (CollabMessage m in messages.TakeLast(tail))
        {
            Console.WriteLine(m.ToLine());
        }

        return 0;
    }

    private static int CmdWait(ArgMap a)
    {
        Config cfg = Config.FromEnvironment();
        string target = (a.Get("agent") ?? cfg.Counterpart).ToUpperInvariant();
        DateTimeOffset since = a.GetTimestamp("since") ?? DateTimeOffset.UtcNow;
        int timeoutSec = a.GetInt("timeout", 1800);
        int intervalSec = Math.Max(a.GetInt("interval", 20), 5);

        using var gh = new GitHubGraphQL();
        DiscussionRef? disc = gh.FindDiscussion(cfg);
        if (disc is null)
        {
            Console.Error.WriteLine("lbabus: bus discussion not found (run `lbabus init`).");
            return 2;
        }

        DateTimeOffset deadline = DateTimeOffset.UtcNow.AddSeconds(timeoutSec);
        Console.Error.WriteLine($"[wait] {target} after {since:yyyy-MM-ddTHH:mm:ss.fffZ} on {disc.Url} (timeout {timeoutSec}s)");

        int poll = 0;
        while (true)
        {
            poll++;
            List<CollabMessage> hits = ParseAll(gh.ListComments(cfg, disc.Number, 50))
                .Where(m => Eq(m.Agent, target) && m.CreatedAt > since)
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

    private static List<CollabMessage> ParseAll(IReadOnlyList<DiscussionComment> comments)
    {
        var list = new List<CollabMessage>();
        foreach (DiscussionComment c in comments)
        {
            CollabMessage? m = CollabMessage.TryParse(c.Body, c.CreatedAt);
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
              lbabus init
              lbabus post --type <T> [--task <id>] [--message <m> | --message-file <f>] [--ref <sha>] [--next <n>] [--to <A>]
              lbabus poll [--tail <N>] [--agent <A>] [--type <T>] [--since <iso>]
              lbabus wait [--agent LINUX|WIN] [--since <iso>] [--timeout <sec>] [--interval <sec>]

            CONFIG (env)
              VIHS_COLLAB_OWNER      default LabVIEW-Community-CI-CD
              VIHS_COLLAB_REPO       default labview-benchmark-actor
              VIHS_COLLAB_CATEGORY   default General
              VIHS_COLLAB_TITLE      default 'labview-benchmark-actor coordination bus (WIN <-> LINUX)'
              VIHS_COLLAB_AGENT      default WIN on Windows, LINUX otherwise

            AUTH: GH_TOKEN / GITHUB_TOKEN, else `gh auth token`.
            """);
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
