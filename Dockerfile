FROM oven/bun:1

WORKDIR /app

# Dependências primeiro para aproveitar o cache de camadas
COPY package.json bun.lock* bun.lockb* ./
RUN bun install

COPY . .

ENV NODE_ENV=production
EXPOSE 3000

CMD ["bun", "src/main.ts"]
