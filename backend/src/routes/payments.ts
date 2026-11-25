import { Hono } from "hono";
import { z } from "zod";
import { adminAccess, currentUser } from "../lib/auth";
import type { AppEnv } from "../lib/types";
import { validate } from "../lib/validate";
import { onlyDigits } from "../lib/text";
import {
  asaasWebhook, confirmPaymentManually, mercadoPagoWebhook, orderPayments, paymentOverview, ProviderError,
  resendPayment, savePaymentSettings,
} from "../repos/payments";
import { db } from "../db";
import { notFound } from "../lib/errors";

// Avisos dos provedores. Respondem 200 rápido; a situação real é consultada no provedor antes de confirmar.
export const paymentWebhookRoutes = new Hono<AppEnv>()
  .post("/webhooks/mercadopago", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const type = c.req.query("type") ?? c.req.query("topic") ?? body?.type;
    const id = c.req.query("data.id") ?? c.req.query("id") ?? body?.data?.id;
    try { await mercadoPagoWebhook(type, id ? String(id) : undefined); }
    catch (e) { console.error("[pagamentos] aviso do Mercado Pago:", e instanceof Error ? e.message : e); }
    return c.json({ ok: true });
  })
  .post("/webhooks/asaas", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    try {
      await asaasWebhook(c.req.header("asaas-access-token"), body);
    } catch (e) {
      if (e instanceof ProviderError) return c.json({ error: e.message }, 401);
      console.error("[pagamentos] aviso do Asaas:", e instanceof Error ? e.message : e);
    }
    return c.json({ ok: true });
  });

const settingsSchema = z.object({
  provider: z.enum(["manual_pix", "mercadopago", "asaas", "efi"]),
  cardLink: z.boolean(),
  pixKey: z.string().trim().max(77),
  merchantName: z.string().trim().min(2).max(25),
  merchantCity: z.string().trim().min(2).max(15),
  expiresMinutes: z.number().int().min(30).max(60 * 24 * 3),
  reminderMinutes: z.number().int().min(5).max(60 * 24),
}).partial();

async function orderId(code: string) {
  const [o] = await db()`select id from orders where code = ${code}`;
  if (!o) throw notFound("Pedido");
  return o.id as number;
}

export const paymentAdminRoutes = new Hono<AppEnv>()
  .use(adminAccess)
  .get("/settings", async (c) => c.json(await paymentOverview()))
  .put("/settings", validate("json", settingsSchema), async (c) => {
    await savePaymentSettings(c.req.valid("json"));
    return c.json(await paymentOverview());
  })
  .get("/orders/:code", async (c) => c.json({ payments: await orderPayments(await orderId(c.req.param("code"))) }))
  .post("/orders/:code/confirm", async (c) => {
    const u = currentUser(c);
    return c.json({ payments: await confirmPaymentManually(c.req.param("code"), u.id, u.name) });
  })
  .post("/orders/:code/resend", validate("json", z.object({ document: z.string().optional() })), async (c) => {
    const doc = c.req.valid("json").document;
    try {
      return c.json({ payments: await resendPayment(c.req.param("code"), doc ? onlyDigits(doc) : undefined) });
    } catch (e) {
      if (e instanceof ProviderError) return c.json({ error: { code: "provider_error", message: e.message } }, 502);
      throw e;
    }
  });
