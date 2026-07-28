using System.Diagnostics;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;

namespace LabViewBenchmarkActor.CollabBus;

public sealed record DiscussionRef(int Number, string Id, string Url);
public sealed record DiscussionComment(DateTimeOffset CreatedAt, string AuthorLogin, string Body);

/// <summary>
/// Minimal GitHub GraphQL client for the coordination bus. Auth token is taken from
/// <c>gh auth token</c> (fallback <c>GH_TOKEN</c>/<c>GITHUB_TOKEN</c>). All calls are in-process
/// HTTP — no shelling out to <c>gh api</c>, no pager, so behaviour is identical on Windows and Linux.
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

    private static string GraphQlEndpoint => $"{ApiBase}/graphql";
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

    public JsonElement Query(string query, IReadOnlyDictionary<string, object?>? variables = null)
    {
        var payload = new Dictionary<string, object?>
        {
            ["query"] = query,
            ["variables"] = variables ?? new Dictionary<string, object?>(),
        };

        string json = JsonSerializer.Serialize(payload);
        using var content = new StringContent(json, Encoding.UTF8, "application/json");
        using HttpResponseMessage resp = _http.PostAsync(GraphQlEndpoint, content).GetAwaiter().GetResult();
        string body = resp.Content.ReadAsStringAsync().GetAwaiter().GetResult();

        if (!resp.IsSuccessStatusCode)
        {
            throw new InvalidOperationException($"GitHub GraphQL HTTP {(int)resp.StatusCode}: {Truncate(body)}");
        }

        using var doc = JsonDocument.Parse(body);
        JsonElement root = doc.RootElement;
        if (root.TryGetProperty("errors", out JsonElement errors) && errors.ValueKind == JsonValueKind.Array && errors.GetArrayLength() > 0)
        {
            throw new InvalidOperationException($"GitHub GraphQL error: {Truncate(errors.ToString())}");
        }

        // Clone the data element so it survives disposal of the JsonDocument.
        return root.GetProperty("data").Clone();
    }

    public (string RepoId, string CategoryId) ResolveContext(Config cfg)
    {
        const string q = "query($owner:String!,$name:String!){repository(owner:$owner,name:$name){id discussionCategories(first:30){nodes{id name}}}}";
        JsonElement data = Query(q, new Dictionary<string, object?> { ["owner"] = cfg.Owner, ["name"] = cfg.Repo });
        JsonElement repo = data.GetProperty("repository");
        string repoId = repo.GetProperty("id").GetString()!;

        foreach (JsonElement node in repo.GetProperty("discussionCategories").GetProperty("nodes").EnumerateArray())
        {
            string name = node.GetProperty("name").GetString() ?? "";
            if (string.Equals(name, cfg.Category, StringComparison.OrdinalIgnoreCase))
            {
                return (repoId, node.GetProperty("id").GetString()!);
            }
        }

        throw new InvalidOperationException($"Discussion category \"{cfg.Category}\" not found in {cfg.Owner}/{cfg.Repo}.");
    }

    public DiscussionRef? FindDiscussion(Config cfg)
    {
        const string q = "query($owner:String!,$name:String!){repository(owner:$owner,name:$name){discussions(first:50,orderBy:{field:CREATED_AT,direction:DESC}){nodes{number title id url}}}}";
        JsonElement data = Query(q, new Dictionary<string, object?> { ["owner"] = cfg.Owner, ["name"] = cfg.Repo });
        foreach (JsonElement node in data.GetProperty("repository").GetProperty("discussions").GetProperty("nodes").EnumerateArray())
        {
            if (string.Equals(node.GetProperty("title").GetString(), cfg.Title, StringComparison.Ordinal))
            {
                return new DiscussionRef(node.GetProperty("number").GetInt32(), node.GetProperty("id").GetString()!, node.GetProperty("url").GetString()!);
            }
        }

        return null;
    }

    public DiscussionRef CreateDiscussion(Config cfg, string body)
    {
        (string repoId, string categoryId) = ResolveContext(cfg);
        const string m = "mutation($repo:ID!,$cat:ID!,$title:String!,$body:String!){createDiscussion(input:{repositoryId:$repo,categoryId:$cat,title:$title,body:$body}){discussion{number url id}}}";
        JsonElement data = Query(m, new Dictionary<string, object?>
        {
            ["repo"] = repoId,
            ["cat"] = categoryId,
            ["title"] = cfg.Title,
            ["body"] = body,
        });
        JsonElement d = data.GetProperty("createDiscussion").GetProperty("discussion");
        return new DiscussionRef(d.GetProperty("number").GetInt32(), d.GetProperty("id").GetString()!, d.GetProperty("url").GetString()!);
    }

    public DiscussionRef EnsureDiscussion(Config cfg, string seedBody)
        => FindDiscussion(cfg) ?? CreateDiscussion(cfg, seedBody);

    public IReadOnlyList<DiscussionComment> ListComments(Config cfg, int number, int lastN)
    {
        const string q = "query($owner:String!,$name:String!,$number:Int!,$last:Int!){repository(owner:$owner,name:$name){discussion(number:$number){comments(last:$last){nodes{createdAt body author{login}}}}}}";
        JsonElement data = Query(q, new Dictionary<string, object?>
        {
            ["owner"] = cfg.Owner,
            ["name"] = cfg.Repo,
            ["number"] = number,
            ["last"] = lastN,
        });

        var results = new List<DiscussionComment>();
        foreach (JsonElement node in data.GetProperty("repository").GetProperty("discussion").GetProperty("comments").GetProperty("nodes").EnumerateArray())
        {
            DateTimeOffset created = node.GetProperty("createdAt").GetDateTimeOffset();
            string login = node.TryGetProperty("author", out JsonElement author) && author.ValueKind == JsonValueKind.Object
                ? author.GetProperty("login").GetString() ?? ""
                : "";
            string body = node.GetProperty("body").GetString() ?? "";
            results.Add(new DiscussionComment(created, login, body));
        }

        return results;
    }

    public string AddComment(string discussionId, string body)
    {
        const string m = "mutation($id:ID!,$body:String!){addDiscussionComment(input:{discussionId:$id,body:$body}){comment{url}}}";
        JsonElement data = Query(m, new Dictionary<string, object?> { ["id"] = discussionId, ["body"] = body });
        return data.GetProperty("addDiscussionComment").GetProperty("comment").GetProperty("url").GetString()!;
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
