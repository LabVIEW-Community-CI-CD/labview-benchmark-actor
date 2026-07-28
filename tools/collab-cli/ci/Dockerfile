# Docker-CI edge-case harness for the lbabus coordination CLI.
#
# The runner (ci/LbaBus.Ci) executes the declarative cases/*.json against a freshly built lbabus and
# fails the image build if any case fails — so wiring these targets into the release pipeline gates a
# publish on the harness. Two runtime stages exercise the ripgrep-present and ripgrep-absent paths.
#
#   docker build -f tools/collab-cli/ci/Dockerfile --target ci-rg    .
#   docker build -f tools/collab-cli/ci/Dockerfile --target ci-no-rg .
#
# The in-container GitHub mock (ci/LbaBus.Ci.Mock, see ci/README.md — "Mock contract") is launched by
# the mock's `run-harness` mode before the cases run: it binds a loopback endpoint, exports
# LBABUS_GITHUB_API at it, and speaks the {base}/graphql + {base}/repos/... surface, so the
# version-guard-* and defect-* mock-requiring cases RUN here (they SKIP only when the mock is absent).

# ---- build stage: publish the CLI, the runner, and the mock ---------------------------------------
FROM mcr.microsoft.com/dotnet/sdk:8.0 AS build
WORKDIR /src
COPY . .
RUN dotnet publish tools/collab-cli/LbaBus.csproj -c Release -o /out/cli \
 && dotnet publish tools/collab-cli/ci/LbaBus.Ci/LbaBus.Ci.csproj -c Release -o /out/ci \
 && dotnet publish tools/collab-cli/ci/LbaBus.Ci.Mock/LbaBus.Ci.Mock.csproj -c Release -o /out/mock \
 && dotnet publish tools/collab-cli/ci/LbaBus.Ci.Stress/LbaBus.Ci.Stress.csproj -c Release -o /out/stress

# ---- ci-rg: ripgrep present -> offline + mock cases RUN and PASS, no-rg case SKIP ------------------
FROM mcr.microsoft.com/dotnet/sdk:8.0 AS ci-rg
# ripgrep is the one pinned tool the offline grep cases need (git ships in the sdk image).
RUN apt-get update && apt-get install -y --no-install-recommends ripgrep && rm -rf /var/lib/apt/lists/*
COPY --from=build /out /out
COPY tools/collab-cli/ci /repo/tools/collab-cli/ci
# run-harness starts the loopback GitHub mock (HttpListener.Start() is synchronous, so no readiness
# race), exports LBABUS_GITHUB_API, runs the case runner, and exits with the runner's exit code.
RUN dotnet /out/mock/lbabus-mock.dll run-harness --port 8099 \
      --repo-root /repo --lbabus /out/cli/lbabus.dll --runner /out/ci/lbabus-ci.dll

# ---- ci-no-rg: ripgrep deliberately absent -> the ripgrep-only fail-closed (exit 4) case RUNS ------
FROM mcr.microsoft.com/dotnet/sdk:8.0 AS ci-no-rg
COPY --from=build /out /out
COPY tools/collab-cli/ci /repo/tools/collab-cli/ci
# The mock is wired here too: the mock-requiring cases do not depend on ripgrep, so they RUN in this
# stage as well and prove the seam is independent of the search toolchain.
RUN dotnet /out/mock/lbabus-mock.dll run-harness --port 8099 \
      --repo-root /repo --lbabus /out/cli/lbabus.dll --runner /out/ci/lbabus-ci.dll

# ---- ci-stress: cross-process lease mutual-exclusion regression gate (LINUX #15 stress) -----------
# Spawns many concurrent `lbabus resource acquire` processes and asserts mutual exclusion holds on a
# FREE and a STALE lease (+ ttl/pid steal, idempotent release, wait). This is the gate for the
# concurrency mutex break the LINUX stress corpus found in PR #18 — a low-round manual check passes it
# by luck, so the release must run the intense version.
FROM mcr.microsoft.com/dotnet/sdk:8.0 AS ci-stress
COPY --from=build /out /out
RUN dotnet /out/stress/lbabus-stress.dll --lbabus /out/cli/lbabus.dll --agents 16 --rounds 30

# ---- ci-agents: version-pinned agent base-instructions embed round-trips + drift is detected --------
# Proves `lbabus agents` emits the embedded canonical AGENTS.md, that a materialized copy re-verifies
# (--check exit 0), and that any drift is caught (--check non-zero). This is what makes "same lbabus
# version => same base instructions" enforceable across every session.
FROM mcr.microsoft.com/dotnet/sdk:8.0 AS ci-agents
COPY --from=build /out /out
RUN set -eux; \
    dotnet /out/cli/lbabus.dll agents --out /tmp/AGENTS.md; \
    dotnet /out/cli/lbabus.dll agents --check /tmp/AGENTS.md; \
    printf '\ndrift line\n' >> /tmp/AGENTS.md; \
    if dotnet /out/cli/lbabus.dll agents --check /tmp/AGENTS.md; then echo "ci-agents: drift NOT detected" >&2; exit 1; fi; \
    echo "ci-agents: embed round-trip + drift detection OK"

# ---- ci-docs: the version-pinned documentation package embeds + round-trips + drift-detects --------
FROM mcr.microsoft.com/dotnet/sdk:8.0 AS ci-docs
COPY --from=build /out /out
RUN set -eux; \
    dotnet /out/cli/lbabus.dll docs --out /tmp/DOCS.md; \
    dotnet /out/cli/lbabus.dll docs --check /tmp/DOCS.md; \
    printf '\ndrift line\n' >> /tmp/DOCS.md; \
    if dotnet /out/cli/lbabus.dll docs --check /tmp/DOCS.md; then echo "ci-docs: drift NOT detected" >&2; exit 1; fi; \
    echo "ci-docs: embed round-trip + drift detection OK"

# ---- ci-musl: framework-dependent lbabus on musl (Alpine) -> harness runs GREEN (portable IL) ------
# Proves the SHIPPED nupkg / framework-dependent path (portable lbabus.dll + runner + HttpListener mock)
# runs on musl byte-identically to glibc. ripgrep comes from apk. Positive half of the #10 RID contract.
FROM mcr.microsoft.com/dotnet/sdk:8.0-alpine AS ci-musl
RUN apk add --no-cache ripgrep
COPY --from=build /out /out
COPY tools/collab-cli/ci /repo/tools/collab-cli/ci
RUN dotnet /out/mock/lbabus-mock.dll run-harness --port 8099 \
      --repo-root /repo --lbabus /out/cli/lbabus.dll --runner /out/ci/lbabus-ci.dll

# ---- ci-musl-native: the glibc self-contained native FAILS on musl (RID contract, negative) --------
# The published linux-x64 self-contained single-file binary targets glibc; it must NOT silently run on
# musl. It fails clearly (missing ld-linux-x86-64.so.2 -> not found / exit 127), proving the RID matters.
FROM mcr.microsoft.com/dotnet/sdk:8.0 AS build-native
WORKDIR /src
COPY . .
RUN dotnet publish tools/collab-cli/LbaBus.csproj -c Release -r linux-x64 --self-contained true \
      -p:PublishSingleFile=true -o /out/native

FROM alpine:3.20 AS ci-musl-native
COPY --from=build-native /out/native/lbabus /usr/local/bin/lbabus
RUN if /usr/local/bin/lbabus version >/dev/null 2>&1; then \
        echo "FAIL: glibc self-contained native unexpectedly ran on musl" && exit 1; \
    else \
        echo "OK: glibc self-contained native correctly fails on musl (RID contract holds, exit $?)"; \
    fi
