using System.Net;
using System.Text;
using System.Text.RegularExpressions;

namespace LabViewBenchmarkActor.CollabBus.CiMock;

/// <summary>
/// The HttpListener-backed mock. Single-threaded accept loop on a background thread: lbabus makes
/// strictly sequential, awaited HTTP calls, so there is no concurrency to serialize. Every handler is
/// a pure function of the request — no persisted state — so cases are order-independent.
/// </summary>
internal sealed class MockServer : IDisposable
{
    private readonly HttpListener _listener = new();
    private readonly string _currentVersion;
    private Thread? _thread;
    private volatile bool _running;
    private int _served;

    public int Served => _served;

    public MockServer(int port, string currentVersion)
    {
        _currentVersion = currentVersion;
        _listener.Prefixes.Add($"http://127.0.0.1:{port}/");
    }

    public void Start()
    {
        _listener.Start(); // synchronous: the socket is bound and listening when this returns.
        _running = true;
        _thread = new Thread(Loop) { IsBackground = true, Name = "lbabus-mock" };
        _thread.Start();
    }

    public void Stop()
    {
        if (!_running)
        {
            return;
        }

        _running = false;
        try
        {
            _listener.Stop();
        }
        catch
        {
            // already stopped
        }
    }

    private void Loop()
    {
        while (_running)
        {
            HttpListenerContext ctx;
            try
            {
                ctx = _listener.GetContext();
            }
            catch
            {
                break; // listener stopped
            }

            try
            {
                Handle(ctx);
            }
            catch
            {
                // Never let a single malformed request wedge the harness; the case will just fail its
                // expectation, which is the honest signal.
                try
                {
                    ctx.Response.Abort();
                }
                catch
                {
                    // ignore
                }
            }
        }
    }

    private void Handle(HttpListenerContext ctx)
    {
        Interlocked.Increment(ref _served);
        string path = ctx.Request.Url?.AbsolutePath ?? "/";
        string method = ctx.Request.HttpMethod;
        string body = ReadBody(ctx.Request);
        Console.Error.WriteLine($"lbabus-mock: {method} {path}");

        if (path.Equals("/graphql", StringComparison.Ordinal))
        {
            WriteJson(ctx, 200, GraphQl(body));
            return;
        }

        // REST: /repos/{owner}/{repo}/releases  and  /repos/{owner}/{repo}/issues/{n}/comments
        string[] seg = path.Trim('/').Split('/');
        if (seg.Length >= 4 && seg[0].Equals("repos", StringComparison.Ordinal))
        {
            string owner = seg[1];
            string repo = seg[2];

            if (seg[3].Equals("releases", StringComparison.Ordinal))
            {
                WriteJson(ctx, 200, Fixtures.Releases(repo, _currentVersion));
                return;
            }

            if (seg.Length >= 6 && seg[3].Equals("issues", StringComparison.Ordinal)
                && seg[5].Equals("comments", StringComparison.Ordinal))
            {
                string number = seg[4];
                string url = $"https://github.com/{owner}/{repo}/issues/{number}#issuecomment-1000";
                WriteJson(ctx, 201, $"{{\"html_url\":{Json.Str(url)}}}");
                return;
            }
        }

        WriteJson(ctx, 404, "{\"message\":\"lbabus-mock: unrouted path\"}");
    }

    private string GraphQl(string body)
    {
        // Route discussion comments/releases by the fixture repo carried in the GraphQL variables.
        string repo = FirstGroup(body, "\"name\"\\s*:\\s*\"([^\"]+)\"");

        // Order: most-specific operation text first (mutations before the queries they resemble).
        if (body.Contains("addDiscussionComment", StringComparison.Ordinal))
        {
            return "{\"data\":{\"addDiscussionComment\":{\"comment\":{\"url\":\"https://github.com/lbabus-ci/mock/discussions/1#discussioncomment-1\"}}}}";
        }

        if (body.Contains("createDiscussion", StringComparison.Ordinal))
        {
            return "{\"data\":{\"createDiscussion\":{\"discussion\":{\"number\":1,\"url\":\"https://github.com/lbabus-ci/mock/discussions/1\",\"id\":\"D_mock\"}}}}";
        }

        if (body.Contains("discussionCategories", StringComparison.Ordinal))
        {
            return "{\"data\":{\"repository\":{\"id\":\"R_mock\",\"discussionCategories\":{\"nodes\":[{\"id\":\"C_general\",\"name\":\"General\"}]}}}}";
        }

        if (body.Contains("discussion(number", StringComparison.Ordinal))
        {
            return $"{{\"data\":{{\"repository\":{{\"discussion\":{{\"comments\":{{\"nodes\":[{Fixtures.CommentNodes(repo)}]}}}}}}}}}}";
        }

        if (body.Contains("discussions(first", StringComparison.Ordinal))
        {
            string title = Json.Str(Fixtures.DefaultTitle);
            return $"{{\"data\":{{\"repository\":{{\"discussions\":{{\"nodes\":[{{\"number\":1,\"title\":{title},\"id\":\"D_mock\",\"url\":\"https://github.com/lbabus-ci/mock/discussions/1\"}}]}}}}}}}}";
        }

        // Unknown query — benign empty data (not expected to be reached by the wired cases).
        return "{\"data\":{}}";
    }

    private static string ReadBody(HttpListenerRequest req)
    {
        if (!req.HasEntityBody)
        {
            return string.Empty;
        }

        using var reader = new StreamReader(req.InputStream, req.ContentEncoding ?? Encoding.UTF8);
        return reader.ReadToEnd();
    }

    private static void WriteJson(HttpListenerContext ctx, int status, string json)
    {
        byte[] bytes = Encoding.UTF8.GetBytes(json);
        ctx.Response.StatusCode = status;
        ctx.Response.ContentType = "application/json; charset=utf-8";
        ctx.Response.ContentLength64 = bytes.Length;
        ctx.Response.OutputStream.Write(bytes, 0, bytes.Length);
        ctx.Response.OutputStream.Close();
    }

    private static string FirstGroup(string input, string pattern)
    {
        Match m = Regex.Match(input, pattern);
        return m.Success ? m.Groups[1].Value : string.Empty;
    }

    public void Dispose()
    {
        Stop();
        try
        {
            _listener.Close();
        }
        catch
        {
            // ignore
        }
    }
}
