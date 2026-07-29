namespace LabViewBenchmarkActor.CollabBus.CiMock;

/// <summary>
/// Per-fixture-repo canned data. The mock is a pure function of the fixture repo carried in the
/// request (path for REST, <c>variables.name</c> for GraphQL), so cases are order-independent and
/// there is no shared mutable state.
///
/// Non-ASCII literals are written as <c>\uXXXX</c> so this source file stays ASCII-clean; they become
/// real UTF-8 bytes on the wire, which is exactly what the unicode round-trip case asserts survives.
/// </summary>
internal static class Fixtures
{
    /// <summary>Default bus discussion title (the <c>Config.FromEnvironment</c> fallback). FindDiscussion matches on it.</summary>
    public const string DefaultTitle = "labview-benchmark-actor coordination bus (WIN <-> LINUX)";

    /// <summary><c>GET /repos/{owner}/{repo}/releases</c> -> <c>[{ tag_name }]</c>, routed by fixture repo.</summary>
    public static string Releases(string repo, string currentVersion)
    {
        if (EndsWith(repo, "fixture-stale"))
        {
            // A release far ahead of any build -> the version-currency guard must fail closed (exit 3, STALE).
            return "[{\"tag_name\":\"collab-cli-v99.0.0\"}]";
        }

        if (EndsWith(repo, "fixture-current") || EndsWith(repo, "fixture-since") || EndsWith(repo, "fixture-skew") || EndsWith(repo, "fixture-same-second"))
        {
            // Exactly the running build -> the guard passes and the command proceeds.
            return $"[{{\"tag_name\":\"collab-cli-v{currentVersion}\"}}]";
        }

        return "[]";
    }

    /// <summary><c>POST /graphql</c> discussion comment nodes, routed by fixture repo.</summary>
    public static string CommentNodes(string repo)
    {
        if (EndsWith(repo, "fixture-parse"))
        {
            // Two canned messages: one multibyte-UTF-8, one CRLF-bodied with a multi-line msg tail.
            string unicode = CommentNode(
                "2020-06-01T09:00:00Z",
                MsgBlock("WIN", "2020-06-01T09:00:00.000Z", "NOTE",
                    "caf\u00e9 \u2194 \u65e5\u672c\u8a9e \u2192 benchmark actor unicode probe", "\n"));

            string crlf = CommentNode(
                "2020-06-01T09:05:00Z",
                MsgBlock("WIN", "2020-06-01T09:05:00.000Z", "NOTE",
                    "crlf-line-one\r\ncrlf-line-two\r\ncrlf-tail-preserved", "\r\n"));

            return unicode + "," + crlf;
        }

        if (EndsWith(repo, "fixture-since"))
        {
            // One WIN message at server-time 10:00:00Z — the --since offset case compares against it.
            return CommentNode(
                "2020-06-01T10:00:00Z",
                MsgBlock("WIN", "2020-06-01T10:00:00.000Z", "NOTE",
                    "since-offset benchmark probe", "\n"));
        }

        if (EndsWith(repo, "fixture-skew"))
        {
            // A WIN message whose SERVER createdAt is 10:00:00Z but whose sender-embedded ts is 15:12:00Z
            // (+5h12m) -- a real cross-actor clock skew. poll must render the AUTHORITATIVE server time and
            // surface a clock-skew note so the reader never mistakes the sender's future-stamped ts for reality
            // (the bus flaw where drift makes a peer look like it answered much earlier/later than it did).
            return CommentNode(
                "2020-06-01T10:00:00Z",
                MsgBlock("WIN", "2020-06-01T15:12:00.000Z", "NOTE",
                    "skewed-clock benchmark probe", "\n"));
        }

        if (EndsWith(repo, "fixture-same-second"))
        {
            // A LINUX message (the reader's last) and a WIN reply in the SAME whole second (12:00:00Z). A bare
            // `wait --agent WIN` must cursor from the LINUX message and STILL surface the same-second WIN reply
            // (issue #100 -- a strict createdAt > since compare would silently drop it because GitHub createdAt
            // is second-granular).
            string linux = CommentNode("2020-06-01T12:00:00Z",
                MsgBlock("LINUX", "2020-06-01T12:00:00.000Z", "NOTE", "linux baseline post", "\n"));
            string win = CommentNode("2020-06-01T12:00:00Z",
                MsgBlock("WIN", "2020-06-01T12:00:00.000Z", "NOTE", "same-second WIN reply probe", "\n"));
            return linux + "," + win;
        }

        if (EndsWith(repo, "fixture-priority"))
        {
            // Three FLAT additive envelopes (prio/agentId/to are flat scalars) that parse through the
            // real TryParse so the --to-me and --min-priority filters can slice them, plus two negatives
            // that MUST silently drop (bus finding 17812593): a NESTED priority object and a schema@v2
            // bump each defeat the v1 flat-object extractor regex, so an older reader never sees them.
            string a = CommentNode("2020-06-01T11:00:00Z",
                PriorityMsgBlock("2020-06-01T11:00:00.000Z", "urgent-p0-to-linux", "LINUX", "P0", "LINUX-a"));
            string b = CommentNode("2020-06-01T11:01:00Z",
                PriorityMsgBlock("2020-06-01T11:01:00.000Z", "high-p1-to-win", "WIN", "P1", null));
            string c = CommentNode("2020-06-01T11:02:00Z",
                PriorityMsgBlock("2020-06-01T11:02:00.000Z", "routine-p3-broadcast", null, "P3", null));
            string nested = CommentNode("2020-06-01T11:03:00Z", RawJsonBody("nested-priority-must-drop",
                "{\"schema\":\"vihs-collab-msg@v1\",\"v\":1,\"agent\":\"WIN\",\"ts\":\"2020-06-01T11:03:00.000Z\",\"type\":\"NOTE\",\"msg\":\"nested-priority-must-drop\",\"priority\":{\"tier\":\"P0\"}}"));
            string bumped = CommentNode("2020-06-01T11:04:00Z", RawJsonBody("schema-bumped-must-drop",
                "{\"schema\":\"vihs-collab-msg@v2\",\"v\":2,\"agent\":\"WIN\",\"ts\":\"2020-06-01T11:04:00.000Z\",\"type\":\"NOTE\",\"msg\":\"schema-bumped-must-drop\"}"));
            return string.Join(",", new[] { a, b, c, nested, bumped });
        }

        // fixture-current + everything else: an empty discussion -> wait finds no match -> timeout (exit 2).
        return string.Empty;
    }

    /// <summary>A rendered <c>vihs-collab-msg@v1</c> comment body: prose header + the flat fenced JSON block.</summary>
    private static string MsgBlock(string agent, string ts, string type, string msg, string sep)
    {
        string json =
            "{\"schema\":\"vihs-collab-msg@v1\",\"v\":1,\"agent\":\"" + agent +
            "\",\"ts\":\"" + ts + "\",\"type\":\"" + type + "\",\"msg\":" + Json.Str(msg) + "}";

        // "\u00b7" is the middle dot used in the real rendered header.
        return "### [" + agent + "] " + type + " \u00b7 " + ts + sep + sep +
               msg + sep + sep +
               "```json" + sep + json + sep + "```" + sep;
    }

    /// <summary>
    /// A rendered <c>vihs-collab-msg@v1</c> body whose flat JSON also carries the additive
    /// <c>to</c>/<c>prio</c>/<c>agentId</c> scalars (null fields are omitted). Used by the
    /// priority/addressing cases; the fields are FLAT so the v1 extractor still matches.
    /// </summary>
    private static string PriorityMsgBlock(string ts, string msg, string? to, string? prio, string? agentId)
    {
        string json =
            "{\"schema\":\"vihs-collab-msg@v1\",\"v\":1,\"agent\":\"WIN\",\"ts\":\"" + ts +
            "\",\"type\":\"NOTE\",\"msg\":" + Json.Str(msg) +
            (to is null ? "" : ",\"to\":" + Json.Str(to)) +
            (prio is null ? "" : ",\"prio\":" + Json.Str(prio)) +
            (agentId is null ? "" : ",\"agentId\":" + Json.Str(agentId)) +
            "}";
        return "### [WIN] NOTE \u00b7 " + ts + "\n\n" + msg + "\n\n```json\n" + json + "\n```\n";
    }

    /// <summary>
    /// A comment body carrying an ARBITRARY raw JSON block (used for the negative back-read-compat
    /// cases: a nested-object envelope and a schema@v2 bump that must both fail the v1 extractor).
    /// </summary>
    private static string RawJsonBody(string msg, string rawJson) =>
        "### [WIN] NOTE\n\n" + msg + "\n\n```json\n" + rawJson + "\n```\n";

    /// <summary>A GraphQL discussion comment node: <c>{ id, createdAt, body, author{ login } }</c>.</summary>
    private static string CommentNode(string createdAt, string body)
    {
        // Deterministic FNV-1a id from content so the SAME comment keeps the SAME node id across mock polls
        // (issue #100: `wait` cursors by comment id, so the id must be stable + distinct per comment).
        uint h = 2166136261u;
        foreach (char ch in createdAt + "\u0001" + body)
        {
            h = (h ^ ch) * 16777619u;
        }

        string id = "gid_" + h.ToString("x8");
        return "{\"id\":" + Json.Str(id) + ",\"createdAt\":" + Json.Str(createdAt) + ",\"body\":" + Json.Str(body) + ",\"author\":{\"login\":\"mock-bot\"}}";
    }

    private static bool EndsWith(string repo, string suffix) =>
        repo.EndsWith(suffix, StringComparison.OrdinalIgnoreCase);
}
