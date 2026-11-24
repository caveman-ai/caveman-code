# The Caveman Code runtime and web client as OCI images with no OS: Caveman Cloud release builds take
# them as build contexts (`--build-context runtime=docker-image://<ref>@sha256:...`), pinned by digest in
# its PRODUCTS.yaml. The runtime target carries caveman-runtime.tgz at / for each architecture
# (pack:computer output staged as dist/<arch>/caveman-runtime.tgz); the client target is apps/web's
# dist at /, the same on every architecture.
FROM scratch AS runtime
ARG TARGETARCH
COPY dist/${TARGETARCH}/caveman-runtime.tgz /caveman-runtime.tgz

FROM scratch AS client
COPY dist/client/ /
