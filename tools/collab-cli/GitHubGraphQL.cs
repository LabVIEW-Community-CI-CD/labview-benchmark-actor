using System.Diagnostics;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;

namespace LabViewBenchmarkActor.CollabBus;

/// <summary>
/// Minimal GitHub REST client for the two remaining GitHub-API touchpoints — the `selfcheck`
/// version-currency lookup (release tags) and the `lbabus defect` sink (issue comment). Auth token is
/// taken from <c>gh auth token</c> (fallback <c>GH_TOKEN</c>/<c>GITHUB_TOKEN</c>). All calls are in-process
/// HTTP — no shelling out to <c>gh api</c>, no pager, so behaviour is identical on Windows and Linux.
/// The GitHub-Discussion coordination transport was removed (off-Discussions step 8, ADR-0047); coordination
/// rides the live-only `lbabus net` TCP bus.
/// </summary>
public sealed class GitHubGraphQL : IDisposable
{
    private const string DefaultApiBase = "https://api.github.com";

    /// <summary>
    /// Base URL for all GitHub API calls (GraphQL at <c>{base}/graphql</c>, REST at <c>{base}/repos/...</c>).
    /// Overridable via <c>LBABUS_GITHUB_API</c> so a hermetic Docker-CI harness can point every call at an
    /// in-container mock with no real network. Trailing slash is trimmed. When set, the tool is fail-closed:
    /// an unreachable override is a hard error, never a silent fall-back to the real api.github.com.
    /// </summary>
    public static string ApiBase =>
        Environment.GetEnvironmentVariable("LBABUS_GITHUB_API") is { Length: > 0 } o
            ? o.Trim().TrimEnd('/')
            : DefaultApiBase;

    /// <summary>True when <c>LBABUS_GITHUB_API</c> is set — the caller has pinned a specific endpoint.</summary>
    public static bool ApiOverridden =>
        Environment.GetEnvironmentVariable("LBABUS_GITHUB_API") is { Length: > 0 };

    private readonly HttpClient _http;

    public GitHubGraphQL()
    {
        string token = ResolveToken();
        _http = new HttpClient();
        _http.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", token);
        _http.DefaultRequestHeaders.UserAgent.ParseAdd("lbabus/0.5.0");
        _http.DefaultRequestHeaders.Accept.ParseAdd("application/json");
        _http.Timeout = TimeSpan.FromSeconds(30);
    }

    private static string ResolveToken()
    {
        foreach (string name in new[] { "GH_TOKEN", "GITHUB_TOKEN" })
        {
            string? env = Environment.GetEnvironmentVariable(name);
            if (!string.IsNullOrWhiteSpace(env))
            {
                return env.Trim();
            }
        }

        // Fall back to the gh CLI's stored credential.
        try
        {
            var psi = new ProcessStartInfo("gh", "auth token")
            {
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
            };
            using Process? proc = Process.Start(psi);
            if (proc is not null)
            {
                string outText = proc.StandardOutput.ReadToEnd();
                proc.WaitForExit(10_000);
                string token = outText.Trim();
                if (proc.ExitCode == 0 && token.Length > 0)
                {
                    return token;
                }
            }
        }
        catch
        {
            // fall through to the error below
        }

        throw new InvalidOperationException(
            "No GitHub token found. Set GH_TOKEN/GITHUB_TOKEN or run `gh auth login`.");
    }

    /// <summary>REST: all release tag names for the repo (used by the version-currency guard).</summary>
    public IReadOnlyList<string> ListReleaseTags(Config cfg)
    {
        string url = $"{ApiBase}/repos/{cfg.Owner}/{cfg.Repo}/releases?per_page=100";
        using var req = new HttpRequestMessage(HttpMethod.Get, url);
        req.Headers.Accept.Clear();
        req.Headers.Accept.ParseAdd("application/vnd.github+json");
        using HttpResponseMessage resp = _http.SendAsync(req).GetAwaiter().GetResult();
        string body = resp.Content.ReadAsStringAsync().GetAwaiter().GetResult();
        if (!resp.IsSuccessStatusCode)
        {
            throw new InvalidOperationException($"GitHub REST HTTP {(int)resp.StatusCode}: {Truncate(body)}");
        }

        using var doc = JsonDocument.Parse(body);
        var tags = new List<string>();
        foreach (JsonElement el in doc.RootElement.EnumerateArray())
        {
            if (el.TryGetProperty("tag_name", out JsonElement t) && t.GetString() is { } s)
            {
                tags.Add(s);
            }
        }

        return tags;
    }

    /// <summary>REST: append a comment to an issue (used by the sanctioned defect-reporting sink).</summary>
    public string AddIssueComment(Config cfg, int issueNumber, string bodyMarkdown)
    {
        string url = $"{ApiBase}/repos/{cfg.Owner}/{cfg.Repo}/issues/{issueNumber}/comments";
        string payload = JsonSerializer.Serialize(new Dictionary<string, object?> { ["body"] = bodyMarkdown });
        using var req = new HttpRequestMessage(HttpMethod.Post, url);
        req.Headers.Accept.Clear();
        req.Headers.Accept.ParseAdd("application/vnd.github+json");
        req.Content = new StringContent(payload, Encoding.UTF8, "application/json");
        using HttpResponseMessage resp = _http.SendAsync(req).GetAwaiter().GetResult();
        string body = resp.Content.ReadAsStringAsync().GetAwaiter().GetResult();
        if (!resp.IsSuccessStatusCode)
        {
            throw new InvalidOperationException($"GitHub REST HTTP {(int)resp.StatusCode}: {Truncate(body)}");
        }

        using var doc = JsonDocument.Parse(body);
        return doc.RootElement.TryGetProperty("html_url", out JsonElement h) ? h.GetString() ?? url : url;
    }

    private static string Truncate(string s) => s.Length <= 500 ? s : s[..500];

    public void Dispose() => _http.Dispose();
}
