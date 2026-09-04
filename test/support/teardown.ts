import { afterAll } from "bun:test";
import { stopTestStack } from "./containers";

// Pré-carregado via bunfig.toml — roda uma vez depois que todo arquivo de teste
// terminou, para que o Postgres + LocalStack compartilhados do testcontainers
// sejam parados (o Ryuk é apenas a rede de segurança).
afterAll(async () => {
  await stopTestStack();
}, 60_000);
