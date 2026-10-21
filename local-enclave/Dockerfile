# The management app stand-in (standin/). Only the dependencies live in the image: compose.yaml
# bind-mounts the experiments repo at /app and keeps this node_modules in place, so edits hot-reload.
FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
CMD ["node_modules/.bin/tsx", "watch", "local-enclave/standin/main.ts"]
