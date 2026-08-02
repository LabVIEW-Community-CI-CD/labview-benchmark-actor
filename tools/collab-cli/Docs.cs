using System.Reflection;
using System.Security.Cryptography;
using System.Text;

namespace LabViewBenchmarkActor.CollabBus;

/// <summary>
/// <c>lbabus docs</c> — emits the version-pinned DOCUMENTATION BUNDLE that is EMBEDDED in (and therefore
/// pinned to) this <c>lbabus</c> version: the documentation guide plus the repo's CANONICAL software
/// requirements (SRS) and traceability matrix (RTM). It is the documentation companion to
/// <c>lbabus agents</c>: every session on the same version reads byte-identical docs, so "same version =>
/// same requirements" holds by construction and the requirements an agent reads are the ones THIS build
/// was cut from. Iterate the source under <c>docs/</c> and re-release; do not hand-edit a materialized copy.
/// <list type="bullet">
///   <item><c>docs</c>                       — print the documentation guide (default doc) to stdout.</item>
///   <item><c>docs list</c>                  — list the embedded docs (id, kind, sha256, bytes).</item>
///   <item><c>docs show &lt;id&gt;</c>             — print an embedded doc: <c>guide</c>, <c>srs</c>, or <c>rtm</c>.</item>
///   <item><c>docs [show] &lt;id&gt; --out &lt;p&gt;</c>  — materialize a doc to a known file location.</item>
///   <item><c>docs [show] &lt;id&gt; --check &lt;p&gt;</c> — compare a file's body to the embedded canonical; exit 3 on drift.</item>
/// </list>
/// </summary>
internal static class DocsCommand
{
    /// <summary>An embedded documentation artifact. A <see cref="Markdown"/> doc carries an HTML-comment
    /// provenance stamp; a non-markdown doc (the RTM csv) is emitted raw so it stays valid for its own
    /// tooling (a csv cannot hold an HTML comment).</summary>
    private sealed record DocEntry(string Id, string Title, string ResourceSuffix, string Source, bool Markdown);

    private static readonly DocEntry[] Registry =
    {
        new("guide", "documentation package (DOCS.md)",           ".docs.DOCS.md",            "tools/collab-cli/docs/DOCS.md", true),
        new("srs",   "software requirements specification (SRS)", "docs.requirements.srs.md", "docs/requirements/srs.md",      true),
        new("rtm",   "requirements traceability matrix (RTM)",    "docs.requirements.rtm.csv", "docs/requirements/rtm.csv",     false),
    };

    private const string DefaultId = "guide";

    internal static int Run(string[] argv)
    {
        // Leading positionals (verb / id) precede any --flags (ArgMap consumes only --key/--flag tokens),
        // so scan up to the first "--" for `docs [list | [show] <id>]`.
        var positionals = new List<string>();
        foreach (string t in argv) { if (t.StartsWith("--", StringComparison.Ordinal)) { break; } positionals.Add(t); }

        string id = DefaultId;
        if (positionals.Count > 0)
        {
            if (positionals[0].Equals("list", StringComparison.Ordinal)) { return List(); }
            if (positionals[0].Equals("show", StringComparison.Ordinal))
            {
                if (positionals.Count < 2) { return Fail("docs show: missing <id>. Try: lbabus docs list"); }
                id = positionals[1];
            }
            else { id = positionals[0]; } // shorthand: `docs <id>`
        }

        DocEntry? entry = Registry.FirstOrDefault(d => d.Id.Equals(id, StringComparison.OrdinalIgnoreCase));
        if (entry is null)
        {
            return Fail($"docs: unknown doc '{id}'. Known: {string.Join(", ", Registry.Select(d => d.Id))} (or: lbabus docs list)");
        }

        var a = new ArgMap(argv);
        string version = Version();
        string body = Normalize(LoadEmbedded(entry));
        string sha = Sha256(body);

        if (a.Get("check") is { } checkPath && !checkPath.Equals("true", StringComparison.Ordinal))
        {
            if (!File.Exists(checkPath)) { return Fail($"docs --check: file not found: {checkPath}"); }
            string targetBody = Normalize(entry.Markdown ? StripHeader(File.ReadAllText(checkPath)) : File.ReadAllText(checkPath));
            if (Sha256(targetBody) == sha)
            {
                Console.WriteLine($"docs: {checkPath} matches embedded {entry.Id} (v{version} sha256:{sha[..12]})");
                return 0;
            }

            Console.Error.WriteLine($"docs: DRIFT — {checkPath} does not match embedded {entry.Id} (v{version}). Regenerate with: lbabus docs show {entry.Id} --out {checkPath}");
            return 3;
        }

        string outText = entry.Markdown ? Header(entry, version, sha) + body : body;
        if (a.Get("out") is { } outPath && !outPath.Equals("true", StringComparison.Ordinal))
        {
            File.WriteAllText(outPath, outText, new UTF8Encoding(false));
            Console.WriteLine($"docs: wrote {outPath} ({entry.Id} v{version} sha256:{sha[..12]}, {body.Length} bytes)");
            return 0;
        }

        Console.Out.Write(outText);
        if (!outText.EndsWith('\n')) { Console.Out.Write('\n'); }
        return 0;
    }

    /// <summary>Lists every embedded doc with its kind, content digest, and byte length.</summary>
    private static int List()
    {
        string version = Version();
        Console.WriteLine($"docs: {Registry.Length} embedded doc(s) in lbabus v{version}:");
        foreach (DocEntry d in Registry)
        {
            string body = Normalize(LoadEmbedded(d));
            string sha = Sha256(body);
            Console.WriteLine($"  {d.Id,-6} {(d.Markdown ? "markdown" : "csv"),-8} sha256:{sha[..12]}  {body.Length,7}B  {d.Title}  [{d.Source}]");
        }

        return 0;
    }

    private static string Header(DocEntry e, string version, string sha) =>
        $"<!-- lbabus-docs v{version} doc:{e.Id} sha256:{sha} — canonical {e.Title} embedded in lbabus. " +
        $"Do not hand-edit; iterate {e.Source} and re-release. Verify: lbabus docs show {e.Id} --check <path> -->\n\n";

    /// <summary>Drops a leading <c>&lt;!-- lbabus-docs ... --&gt;</c> stamp (and following blank lines) if present.</summary>
    private static string StripHeader(string text)
    {
        if (text.StartsWith("<!-- lbabus-docs ", StringComparison.Ordinal))
        {
            int end = text.IndexOf("-->", StringComparison.Ordinal);
            if (end >= 0) { text = text[(end + 3)..].TrimStart('\r', '\n'); }
        }

        return text;
    }

    private static string Normalize(string s) => s.Replace("\r\n", "\n").TrimEnd() + "\n";

    private static string LoadEmbedded(DocEntry e)
    {
        Assembly asm = typeof(DocsCommand).Assembly;
        string? name = asm.GetManifestResourceNames().FirstOrDefault(n => n.EndsWith(e.ResourceSuffix, StringComparison.Ordinal));
        if (name is null) { throw new InvalidOperationException($"embedded doc resource not found: {e.Id} ({e.ResourceSuffix})"); }
        using Stream s = asm.GetManifestResourceStream(name)!;
        using var reader = new StreamReader(s, Encoding.UTF8);
        return reader.ReadToEnd();
    }

    private static string Version()
    {
        Assembly asm = typeof(DocsCommand).Assembly;
        string? info = asm.GetCustomAttribute<AssemblyInformationalVersionAttribute>()?.InformationalVersion;
        if (!string.IsNullOrEmpty(info)) { int plus = info.IndexOf('+'); return plus > 0 ? info[..plus] : info; }
        return asm.GetName().Version?.ToString() ?? "0.0.0";
    }

    private static string Sha256(string s) =>
        Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(s))).ToLowerInvariant();

    private static int Fail(string message)
    {
        Console.Error.WriteLine($"lbabus: {message}");
        return 2;
    }
}
