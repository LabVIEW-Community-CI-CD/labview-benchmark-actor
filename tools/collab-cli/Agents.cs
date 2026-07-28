using System.Reflection;
using System.Security.Cryptography;
using System.Text;

namespace LabViewBenchmarkActor.CollabBus;

/// <summary>
/// <c>lbabus agents</c> — emits the canonical agent base instructions that are EMBEDDED in (and therefore
/// pinned to) this <c>lbabus</c> version. Every session on the same version shares byte-identical
/// instructions, so the base is a single hardenable control surface that iterates version-over-version.
/// <list type="bullet">
///   <item><c>agents</c>               — print the canonical instructions (stamped header) to stdout.</item>
///   <item><c>agents --out &lt;path&gt;</c>  — materialize them to a known file location.</item>
///   <item><c>agents --check &lt;path&gt;</c> — compare a file's body to the embedded canonical; exit 3 on drift.</item>
/// </list>
/// </summary>
internal static class AgentsCommand
{
    private const string ResourceSuffix = ".agents.AGENTS.md";

    internal static int Run(string[] argv)
    {
        var a = new ArgMap(argv);
        string body = LoadEmbedded();
        string version = Version();
        string sha = Sha256(Normalize(body));

        if (a.Get("check") is { } checkPath)
        {
            if (!File.Exists(checkPath)) { return Fail($"agents --check: file not found: {checkPath}"); }
            string targetBody = Normalize(StripHeader(File.ReadAllText(checkPath)));
            if (Sha256(targetBody) == sha)
            {
                Console.WriteLine($"agents: {checkPath} matches embedded canonical (v{version} sha256:{sha[..12]})");
                return 0;
            }

            Console.Error.WriteLine($"agents: DRIFT — {checkPath} does not match the embedded canonical (v{version}). Regenerate with: lbabus agents --out {checkPath}");
            return 3;
        }

        string stamped = Header(version, sha) + body;
        if (a.Get("out") is { } outPath)
        {
            File.WriteAllText(outPath, stamped, new UTF8Encoding(false));
            Console.WriteLine($"agents: wrote {outPath} (v{version} sha256:{sha[..12]}, {body.Length} bytes)");
            return 0;
        }

        Console.Out.Write(stamped);
        if (!stamped.EndsWith('\n')) { Console.Out.Write('\n'); }
        return 0;
    }

    private static string Header(string version, string sha) =>
        $"<!-- lbabus-agents v{version} sha256:{sha} — canonical base instructions embedded in lbabus. " +
        "Do not hand-edit; iterate tools/collab-cli/agents/AGENTS.md and re-release. Verify: lbabus agents --check <path> -->\n\n";

    /// <summary>Drops a leading <c>&lt;!-- lbabus-agents ... --&gt;</c> stamp (and following blank lines) if present.</summary>
    private static string StripHeader(string text)
    {
        if (text.StartsWith("<!-- lbabus-agents ", StringComparison.Ordinal))
        {
            int end = text.IndexOf("-->", StringComparison.Ordinal);
            if (end >= 0) { text = text[(end + 3)..].TrimStart('\r', '\n'); }
        }

        return text;
    }

    private static string Normalize(string s) => s.Replace("\r\n", "\n").TrimEnd() + "\n";

    private static string LoadEmbedded()
    {
        Assembly asm = typeof(AgentsCommand).Assembly;
        string? name = asm.GetManifestResourceNames().FirstOrDefault(n => n.EndsWith(ResourceSuffix, StringComparison.Ordinal));
        if (name is null) { throw new InvalidOperationException("embedded AGENTS.md resource not found"); }
        using Stream s = asm.GetManifestResourceStream(name)!;
        using var reader = new StreamReader(s, Encoding.UTF8);
        return reader.ReadToEnd();
    }

    private static string Version()
    {
        Assembly asm = typeof(AgentsCommand).Assembly;
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
