using System.Text;

namespace LabViewBenchmarkActor.CollabBus.CiMock;

/// <summary>
/// Minimal JSON string encoder. Escapes only the JSON-significant and control characters and leaves
/// every other character — including multibyte UTF-8 — intact, so the mock exercises a real UTF-8
/// round trip on the wire rather than escaping non-ASCII away as <c>\uXXXX</c>.
/// </summary>
internal static class Json
{
    public static string Str(string value)
    {
        var sb = new StringBuilder(value.Length + 2);
        sb.Append('"');
        foreach (char c in value)
        {
            switch (c)
            {
                case '"': sb.Append("\\\""); break;
                case '\\': sb.Append("\\\\"); break;
                case '\b': sb.Append("\\b"); break;
                case '\f': sb.Append("\\f"); break;
                case '\n': sb.Append("\\n"); break;
                case '\r': sb.Append("\\r"); break;
                case '\t': sb.Append("\\t"); break;
                default:
                    if (c < 0x20)
                    {
                        sb.Append("\\u").Append(((int)c).ToString("x4"));
                    }
                    else
                    {
                        sb.Append(c);
                    }

                    break;
            }
        }

        sb.Append('"');
        return sb.ToString();
    }
}
