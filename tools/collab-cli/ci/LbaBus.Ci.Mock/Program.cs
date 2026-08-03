using System.Diagnostics;
using System.Net;
using System.Text;
using System.Text.RegularExpressions;

namespace LabViewBenchmarkActor.CollabBus.CiMock;

/// <summary>
/// Dependency-free, in-container GitHub mock for the lbabus Docker-CI edge-case harness.
///
/// After the off-Discussions migration (ADR-0047/0048) lbabus uses exactly ONE GitHub-API surface, so the
/// mock serves only it:
/// <list type="bullet">
///   <item><c>POST {base}/repos/{owner}/{repo}/issues/{n}/comments</c> — the `lbabus defect` sink; returns
///     <c>{ html_url }</c>.</item>
/// </list>
/// The mock is a pure function of the request path and never validates the token (<c>GH_TOKEN</c> is a dummy
/// in CI). Two modes:
/// <list type="bullet">
///   <item><c>serve --port N</c> — standalone; runs until killed.</item>
///   <item><c>run-harness --port N --lbabus &lt;dll&gt; --runner &lt;dll&gt; --repo-root &lt;dir&gt;</c> —
///     starts the listener (synchronous — bound before the runner spawns, so there is no readiness race),
///     exports <c>LBABUS_GITHUB_API</c> for the runner, runs it, and exits with the runner's exit code.</item>
/// </list>
/// </summary>
internal static class Program
{
    private static int Main(string[] argv)
    {
        if (argv.Length == 0)
        {
            return Fail("usage: lbabus-mock serve|run-harness [--port N] ...");
        }

        ArgMap a = ArgMap.Parse(argv.Skip(1).ToArray());
        return argv[0].ToLowerInvariant() switch
        {
            "serve" => Serve(a),
            "run-harness" => RunHarness(a),
            _ => Fail($"unknown mode '{argv[0]}' (expected serve|run-harness)"),
        };
    }

    private static int Serve(ArgMap a)
    {
        int port = a.GetInt("port", 8099);
        using var mock = new MockServer(port);
        mock.Start();
        Console.Error.WriteLine($"lbabus-mock: serving http://127.0.0.1:{port}/  (Ctrl-C to stop)");
        Thread.Sleep(Timeout.Infinite);
        return 0;
    }

    private static int RunHarness(ArgMap a)
    {
        int port = a.GetInt("port", 8099);
        string? lbabus = a.Get("lbabus");
        string? runner = a.Get("runner");
        string repoRoot = a.Get("repo-root") ?? Directory.GetCurrentDirectory();
        if (lbabus is null || runner is null)
        {
            return Fail("run-harness requires --lbabus <path> and --runner <path>.");
        }

        using var mock = new MockServer(port);
        mock.Start(); // synchronous: bound + listening on return, so the runner never races the mock.
        Console.Error.WriteLine($"lbabus-mock: listening http://127.0.0.1:{port}/");

        var psi = new ProcessStartInfo { UseShellExecute = false, WorkingDirectory = Path.GetFullPath(repoRoot) };
        if (runner.EndsWith(".dll", StringComparison.OrdinalIgnoreCase))
        {
            psi.FileName = "dotnet";
            psi.ArgumentList.Add(Path.GetFullPath(runner));
        }
        else
        {
            psi.FileName = Path.GetFullPath(runner);
        }

        psi.ArgumentList.Add("--repo-root");
        psi.ArgumentList.Add(Path.GetFullPath(repoRoot));
        psi.ArgumentList.Add("--lbabus");
        psi.ArgumentList.Add(Path.GetFullPath(lbabus));

        // The runner reads its OWN LBABUS_GITHUB_API to decide mockAvailable, then injects it per
        // mock-requiring case (stripping it from every other case for hermeticity). Setting it here is
        // exactly what flips the defect-* cases from SKIP to RUN.
        psi.Environment["LBABUS_GITHUB_API"] = $"http://127.0.0.1:{port}";

        // Inherit stdout/stderr so the runner's per-case log IS the image-build log.
        int exit;
        try
        {
            using Process p = Process.Start(psi) ?? throw new InvalidOperationException("Process.Start returned null");
            p.WaitForExit();
            exit = p.ExitCode;
        }
        catch (Exception ex)
        {
            mock.Stop();
            return Fail($"failed to launch runner: {ex.Message}");
        }

        mock.Stop();
        Console.Error.WriteLine($"lbabus-mock: served {mock.Served} request(s); runner exit {exit}");
        return exit;
    }

    private static int Fail(string message)
    {
        Console.Error.WriteLine("lbabus-mock: " + message);
        return 2;
    }
}
