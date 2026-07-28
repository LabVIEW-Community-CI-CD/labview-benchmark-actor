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

        if (EndsWith(repo, "fixture-current") || EndsWith(repo, "fixture-since"))
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

    /// <summary>A GraphQL discussion comment node: <c>{ createdAt, body, author{ login } }</c>.</summary>
    private static string CommentNode(string createdAt, string body) =>
        "{\"createdAt\":" + Json.Str(createdAt) + ",\"body\":" + Json.Str(body) + ",\"author\":{\"login\":\"mock-bot\"}}";

    private static bool EndsWith(string repo, string suffix) =>
        repo.EndsWith(suffix, StringComparison.OrdinalIgnoreCase);
}
