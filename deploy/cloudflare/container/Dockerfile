# The hosted scanner: Node + git and gitropolis's own scanner (no other dependencies).
# Built from the repository root (see image_build_context in wrangler.jsonc).
FROM node:22-slim
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json ./
COPY src ./src
COPY deploy/cloudflare/container/server.mjs ./container/server.mjs
# scans run as an unprivileged user
RUN useradd -m scanner
USER scanner
EXPOSE 8080
CMD ["node", "container/server.mjs"]
