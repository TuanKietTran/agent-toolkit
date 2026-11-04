FROM ghcr.io/denoland/celld:v0.6.2 AS cell
FROM node:22.15.1-bookworm-slim
COPY --from=cell /usr/local/bin/celld /usr/local/bin/celld
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json wrangler.json ./
COPY src ./src
COPY scripts ./scripts
ENV PATH="/app/node_modules/.bin:${PATH}"
CMD ["npm", "run", "fleet:deploy"]
