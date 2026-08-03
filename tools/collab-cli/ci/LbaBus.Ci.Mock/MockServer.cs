using System.Net;
using System.Text;

namespace LabViewBenchmarkActor.CollabBus.CiMock;

/// <summary>
/// The HttpListener-backed mock. Single-threaded accept loop on a background thread: lbabus makes
/// strictly sequential, awaited HTTP calls, so there is no concurrency to serialize. Every handler is
/// a pure function of the request — no persisted state — so cases are order-independent.
/// </summary>
internal sealed class MockServer : IDisposable
{
    private readonly HttpListener _listener = new();
    private Thread? _thread;
    private volatile bool _running;
    private int _served;

    public int Served => _served;

    public MockServer(int port)
    {
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
        Console.Error.WriteLine($"lbabus-mock: {method} {path}");

        // REST: /repos/{owner}/{repo}/issues/{n}/comments -- the `lbabus defect` issue-comment sink, the ONLY
        // GitHub-API surface lbabus still uses. The Discussion GraphQL + release-tag routes were removed with
        // the Discussion transport (ADR-0047/0048).
        string[] seg = path.Trim('/').Split('/');
        if (seg.Length >= 6 && seg[0].Equals("repos", StringComparison.Ordinal)
            && seg[3].Equals("issues", StringComparison.Ordinal)
            && seg[5].Equals("comments", StringComparison.Ordinal))
        {
            string owner = seg[1];
            string repo = seg[2];
            string number = seg[4];
            string url = $"https://github.com/{owner}/{repo}/issues/{number}#issuecomment-1000";
            WriteJson(ctx, 201, $"{{\"html_url\":{Json.Str(url)}}}");
            return;
        }

        WriteJson(ctx, 404, "{\"message\":\"lbabus-mock: unrouted path\"}");
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
