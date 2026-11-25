import { createApp } from "./app";
import { config } from "./config";
import { runPaymentJobs } from "./repos/payments";

const app = createApp();
const { PORT, DATABASE_URL } = config();

const server = Bun.serve({ port: PORT, fetch: app.fetch, maxRequestBodySize: 11 * 1024 * 1024 });
console.log(`Encantos da Serra API em http://localhost:${server.port}`);

// Pagamentos: a cada minuto confere cobranças em aberto, manda lembretes e cancela as vencidas.
if (DATABASE_URL) {
  const tick = () => runPaymentJobs().catch((e) => console.error("[pagamentos] rotina:", e instanceof Error ? e.message : e));
  setTimeout(tick, 5_000);
  setInterval(tick, 60_000);
}
