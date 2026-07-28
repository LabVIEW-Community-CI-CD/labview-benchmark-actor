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
 && dotnet publish tools/collab-cli/ci/LbaBus.Ci.Mock/LbaBus.Ci.Mock.csproj -c Release -o /out/mock

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
