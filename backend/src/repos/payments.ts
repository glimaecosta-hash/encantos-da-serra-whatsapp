import { readFileSync } from "node:fs";
import { config } from "../config";
import { db } from "../db";
import { brl, type BotMessage } from "../lib/bot";
import { badRequest, conflict, notFound } from "../lib/errors";
import { isValidPixKey } from "../lib/pix";
import {
  asaas, efi, manualPix, mercadoPago, mercadoPagoCardPayment, ProviderError,
  type ChargeStatus, type Provider, type ProviderId,
} from "../lib/paymentProviders";
import { transitionOrder } from "./inventory";
import { messageOrderCustomer, notifyOrderStatus } from "./conversations";

// Pagamento dos pedidos: cria a cobrança no provedor escolhido no painel, manda o Pix (e o link de cartão)
// ao cliente, confirma o pedido quando o pagamento cai, lembra quem não pagou e cancela no fim do prazo
// (o cancelamento devolve a reserva de estoque).

export type PaymentSettings = {
  provider: ProviderId;
  cardLink: boolean;
  pixKey: string;
  merchantName: string;
  merchantCity: string;
  expiresMinutes: number;
  reminderMinutes: number;
};

const DEFAULTS: PaymentSettings = {
  provider: "manual_pix", cardLink: true, pixKey: "", merchantName: "Encantos da Serra", merchantCity: "Belo Horizonte",
  expiresMinutes: 120, reminderMinutes: 30,
};

export async function paymentSettings(): Promise<PaymentSettings> {
  const [row] = await db()`select value from site_settings where key = 'payments'`;
  const v = typeof row?.value === "string" ? JSON.parse(row.value) : row?.value;
  return { ...DEFAULTS, ...(v ?? {}) };
}

export async function savePaymentSettings(patch: Partial<PaymentSettings>) {
  const next = { ...(await paymentSettings()), ...patch };
  if (next.pixKey && !isValidPixKey(next.pixKey)) throw badRequest("Chave Pix inválida: use CPF/CNPJ (só números), e-mail, celular com +55 ou chave aleatória");
  if (next.reminderMinutes >= next.expiresMinutes) throw badRequest("O lembrete precisa vir antes do prazo do Pix");
  await db()`
    insert into site_settings (key, value) values ('payments', ${JSON.stringify(next)}::text::jsonb)
    on conflict (key) do update set value = excluded.value`;
  return next;
}

// ---------- provedores ----------

let efiPem: { cert?: string; key?: string } | null = null;
function readEfiPem() {
  if (efiPem) return efiPem;
  const c = config();
  try {
    const cert = c.EFI_CERT_PATH ? readFileSync(c.EFI_CERT_PATH, "utf8") : undefined;
    const key = c.EFI_KEY_PATH ? readFileSync(c.EFI_KEY_PATH, "utf8") : cert; // um .pem só pode trazer certificado e chave
    efiPem = { cert, key };
  } catch (e) {
    console.error("[pagamentos] não consegui ler o certificado da Efí:", e instanceof Error ? e.message : e);
    efiPem = {};
  }
  return efiPem;
}

export function providerFor(id: ProviderId, s: PaymentSettings): Provider {
  const c = config();
  switch (id) {
    case "mercadopago": return mercadoPago({ accessToken: c.MP_ACCESS_TOKEN });
    case "asaas": return asaas({ apiKey: c.ASAAS_API_KEY, sandbox: c.ASAAS_SANDBOX });
    case "efi": return efi({ clientId: c.EFI_CLIENT_ID, clientSecret: c.EFI_CLIENT_SECRET, ...readEfiPem(), pixKey: c.EFI_PIX_KEY, sandbox: c.EFI_SANDBOX });
    default: return manualPix(s);
  }
}

const PROVIDERS: ProviderId[] = ["manual_pix", "mercadopago", "asaas", "efi"];

// Para o painel: o que cada provedor precisa e qual está ativo.
export async function paymentOverview() {
  const s = await paymentSettings();
  const base = config().PUBLIC_API_URL;
  return {
    settings: s,
    providers: PROVIDERS.map((id) => {
      const p = providerFor(id, s);
      return { id, label: p.label, automatic: p.automatic, needsDocument: p.needsDocument, missing: p.missing, active: id === s.provider };
    }),
    webhooks: {
      publicUrl: base ?? null,
      mercadopago: base ? `${base}/payments/webhooks/mercadopago` : null,
      asaas: base ? `${base}/payments/webhooks/asaas` : null,
    },
  };
}

// O fluxo de compra pergunta o CPF quando o provedor ativo exige.
export async function activeNeedsDocument(): Promise<boolean> {
  const s = await paymentSettings();
  return providerFor(s.provider, s).needsDocument;
}

// ---------- cobrança ----------

const ALNUM = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const newReference = (orderId: number) =>
  `ES${orderId}X${Array.from(crypto.getRandomValues(new Uint8Array(10)), (b) => ALNUM[b % ALNUM.length]).join("")}`.slice(0, 25);

// "14:30 de 25/11"
const timeBr = (d: Date) => {
  const tz = config().TZ_BUSINESS;
  const hm = new Intl.DateTimeFormat("pt-BR", { timeZone: tz, hour: "2-digit", minute: "2-digit" }).format(d);
  const dm = new Intl.DateTimeFormat("pt-BR", { timeZone: tz, day: "2-digit", month: "2-digit" }).format(d);
  return `${hm} de ${dm}`;
};

type PaymentRow = {
  id: number; order_id: number; reference: string; provider: ProviderId; status: string; amount_cents: number;
  external_id: string | null; pix_code: string | null; payment_url: string | null; expires_at: Date; paid_at: Date | null;
  reminded_at: Date | null; created_at: Date;
};

// Mensagens que o cliente recebe: explicação + o código Pix sozinho (fácil de copiar) + link de cartão.
export function paymentMessages(p: Pick<PaymentRow, "pix_code" | "payment_url" | "amount_cents" | "expires_at">, orderCode: string, automatic: boolean, intro = "💳"): BotMessage[] {
  const how = automatic
    ? "A confirmação é automática: assim que o pagamento cair, eu te aviso por aqui."
    : "Depois de pagar, mande o comprovante por aqui que a equipe confirma. 🧀";
  const card = p.payment_url ? `\n\n💳 Prefere cartão? Pague por este link:\n${p.payment_url}` : "";
  const out: BotMessage[] = [{
    body: `${intro} *Pagamento do pedido ${orderCode}*\nTotal: *${brl(p.amount_cents)}*\n\n` +
      (p.pix_code ? `Pague com *Pix copia e cola*: copie a próxima mensagem e cole na área Pix do app do seu banco.\n` : "") +
      `Válido até ${timeBr(new Date(p.expires_at))}.\n\n${how}${card}`,
  }];
  if (p.pix_code) out.push({ body: p.pix_code });
  return out;
}

async function orderForCharge(orderId: number) {
  const [o] = await db()`
    select o.id, o.code, o.status, o.total_cents as "totalCents", u.name, u.email, coalesce(c.phone, u.phone) as phone
    from orders o join users u on u.id = o.user_id left join wa_contacts c on c.user_id = u.id
    where o.id = ${orderId}`;
  if (!o) throw notFound("Pedido");
  return o as { id: number; code: string; status: string; totalCents: number; name: string; email: string; phone: string | null };
}

// Cria a cobrança do pedido no provedor ativo e devolve as mensagens para o cliente.
// Se o provedor falhar, lança ProviderError: quem chama passa o pedido para a equipe.
export async function chargeOrder(orderId: number, opts: { document?: string } = {}): Promise<{ payment: PaymentRow; messages: BotMessage[] }> {
  const s = await paymentSettings();
  const provider = providerFor(s.provider, s);
  const o = await orderForCharge(orderId);
  if (o.status !== "pending") throw conflict(`Pedido ${o.code} não está aguardando pagamento`);

  const reference = newReference(o.id);
  const expiresAt = new Date(Date.now() + s.expiresMinutes * 60_000);
  const base = config().PUBLIC_API_URL;
  const charge = await provider.createCharge({
    reference,
    orderCode: o.code,
    amountCents: o.totalCents,
    description: `Pedido ${o.code} - Encantos da Serra`,
    expiresAt,
    customer: { name: o.name, phone: o.phone ?? "", email: o.email, document: opts.document },
    // Um item com o total do pedido (já com frete e desconto), para o valor cobrado bater exatamente.
    items: [{ title: `Pedido ${o.code} - Encantos da Serra`, quantity: 1, unitPriceCents: o.totalCents }],
    cardLink: s.cardLink,
    notificationUrl: base && provider.id === "mercadopago" ? `${base}/payments/webhooks/mercadopago` : undefined,
  });

  const payment = await db().begin(async (tx) => {
    await tx`update payments set status = 'cancelled' where order_id = ${o.id} and status = 'pending'`;
    const [row] = await tx`
      insert into payments (order_id, reference, provider, amount_cents, external_id, pix_code, payment_url, expires_at)
      values (${o.id}, ${reference}, ${provider.id}, ${o.totalCents}, ${charge.externalId}, ${charge.pixCode}, ${charge.paymentUrl}, ${expiresAt})
      returning *`;
    return row as PaymentRow;
  });
  return { payment, messages: paymentMessages(payment, o.code, provider.automatic) };
}

// ---------- confirmação, lembrete e prazo ----------

// Marca como pago e confirma o pedido (uma vez só, mesmo com avisos repetidos).
export async function markPaid(paymentId: number, via: string, userId: number | null = null) {
  const [p] = await db()`
    update payments set status = 'paid', paid_at = now(), confirmed_by = ${userId}
    where id = ${paymentId} and status in ('pending', 'expired') returning order_id`;
  if (!p) return false;
  const [o] = await db()`select code, status from orders where id = ${p.order_id}`;
  if (o?.status !== "pending") {
    // Pago depois de cancelado (ou já confirmado à mão): a equipe decide entre retomar o pedido ou devolver o valor.
    await systemNote(p.order_id, `⚠️ Pagamento recebido (${via}) com o pedido ${o?.code} em "${o?.status}". Confira e, se for o caso, devolva o valor.`);
    return true;
  }
  await transitionOrder(o.code, "confirmed", { message: `Pagamento confirmado (${via}).`, userId });
  await notifyOrderStatus(p.order_id, "confirmed", "Obrigado! Seu pedido já segue para a separação na câmara fria. 🧊");
  await db()`update conversations set stage = 'won' where order_id = ${p.order_id} and stage <> 'won'`;
  return true;
}

async function systemNote(orderId: number, body: string) {
  const [cv] = await db()`select conversation_id as id from orders where id = ${orderId}`;
  if (cv?.id) await db()`insert into conversation_messages (conversation_id, author, body) values (${cv.id}, 'system', ${body})`;
}

async function expire(p: PaymentRow) {
  const [row] = await db()`update payments set status = 'expired' where id = ${p.id} and status = 'pending' returning id`;
  if (!row) return;
  const [o] = await db()`select code, status from orders where id = ${p.order_id}`;
  if (o?.status !== "pending") return;
  await transitionOrder(o.code, "cancelled", { message: "Cancelado: pagamento não identificado no prazo.", userId: null });
  await notifyOrderStatus(p.order_id, "cancelled", "O pagamento não foi identificado no prazo, então liberamos os produtos. Se ainda quiser, é só pedir de novo por aqui. 🙂");
}

async function remind(p: PaymentRow) {
  const [row] = await db()`update payments set reminded_at = now() where id = ${p.id} and reminded_at is null and status = 'pending' returning id`;
  if (!row) return;
  const [o] = await db()`select code from orders where id = ${p.order_id}`;
  const msgs = paymentMessages(p, o.code, p.provider !== "manual_pix", "⏰ Seu Pix ainda está em aberto.");
  for (const m of msgs) await messageOrderCustomer(p.order_id, m);
}

async function check(p: PaymentRow): Promise<ChargeStatus> {
  if (!p.external_id) return "pending";
  const s = await paymentSettings();
  await db()`update payments set last_checked_at = now() where id = ${p.id}`;
  return providerFor(p.provider, s).checkStatus(p.external_id);
}

let running = false;

// Roda a cada minuto: consulta pagamentos automáticos, manda lembretes e encerra os vencidos.
export async function runPaymentJobs() {
  if (running) return;
  running = true;
  try {
    const pending = await db()`select * from payments where status = 'pending' order by id` as PaymentRow[];
    const s = await paymentSettings();
    for (const p of pending) {
      try {
        if (p.provider !== "manual_pix") {
          const status = await check(p);
          if (status === "paid") { await markPaid(p.id, providerFor(p.provider, s).label.split(" (")[0]!); continue; }
          if (status === "cancelled" || status === "expired") { await expire(p); continue; }
        }
        const expiresAt = new Date(p.expires_at).getTime();
        if (expiresAt <= Date.now()) { await expire(p); continue; }
        const remindAt = new Date(p.created_at).getTime() + s.reminderMinutes * 60_000;
        if (!p.reminded_at && remindAt <= Date.now()) await remind(p);
      } catch (e) {
        console.error(`[pagamentos] cobrança ${p.id}:`, e instanceof Error ? e.message : e);
      }
    }
  } finally {
    running = false;
  }
}

// ---------- avisos dos provedores (webhooks) ----------
// O aviso só diz "algo mudou": a situação real é sempre consultada no provedor.

export async function mercadoPagoWebhook(type: string | undefined, dataId: string | undefined) {
  if (!dataId) return;
  if (type === "order" || type === "orders") {
    const [p] = await db()`select * from payments where provider = 'mercadopago' and external_id = ${dataId} and status in ('pending', 'expired')`;
    if (p && (await check(p as PaymentRow)) === "paid") await markPaid(p.id, "Mercado Pago");
    return;
  }
  if (type === "payment") {
    const token = config().MP_ACCESS_TOKEN;
    if (!token) return;
    const card = await mercadoPagoCardPayment(token, dataId);
    if (!card.approved || !card.reference) return;
    const [p] = await db()`select id from payments where reference = ${card.reference} and provider = 'mercadopago'`;
    if (p) await markPaid(p.id, "Mercado Pago (cartão)");
  }
}

export async function asaasWebhook(token: string | undefined, body: any) {
  const expected = config().ASAAS_WEBHOOK_TOKEN;
  if (!expected || token !== expected) throw new ProviderError("Token do aviso do Asaas inválido");
  const id = body?.payment?.id;
  if (typeof id !== "string") return;
  const [p] = await db()`select * from payments where provider = 'asaas' and external_id = ${id} and status in ('pending', 'expired')`;
  if (p && (await check(p as PaymentRow)) === "paid") await markPaid(p.id, "Asaas");
}

// ---------- painel e conversa ----------

export async function orderPayments(orderId: number) {
  return db()`
    select p.id, p.provider, p.status, p.amount_cents as "amountCents", p.pix_code as "pixCode", p.payment_url as "paymentUrl",
           p.expires_at as "expiresAt", p.paid_at as "paidAt", p.reminded_at as "remindedAt", p.created_at as "createdAt",
           u.name as "confirmedBy"
    from payments p left join users u on u.id = p.confirmed_by
    where p.order_id = ${orderId} order by p.id desc`;
}

async function orderIdByCode(code: string) {
  const [o] = await db()`select id from orders where code = ${code}`;
  if (!o) throw notFound("Pedido");
  return o.id as number;
}

// Equipe confirma o recebimento (Pix copia e cola da loja, comprovante, pagamento combinado).
export async function confirmPaymentManually(code: string, userId: number, userName: string) {
  const orderId = await orderIdByCode(code);
  const [p] = await db()`select id from payments where order_id = ${orderId} and status in ('pending', 'expired') order by id desc limit 1`;
  if (p) {
    await markPaid(p.id, `confirmado por ${userName}`, userId);
  } else {
    const [o] = await db()`select status from orders where id = ${orderId}`;
    if (o.status !== "pending") throw conflict("Este pedido não está aguardando pagamento");
    await transitionOrder(code, "confirmed", { message: `Pagamento confirmado por ${userName}.`, userId });
    await notifyOrderStatus(orderId, "confirmed", "Obrigado! Seu pedido já segue para a separação na câmara fria. 🧊");
  }
  return orderPayments(orderId);
}

// Reenvia o Pix em aberto; se não houver (venceu ou nunca foi gerado), gera um novo.
export async function resendPayment(code: string, document?: string) {
  const orderId = await orderIdByCode(code);
  const [p] = await db()`select * from payments where order_id = ${orderId} and status = 'pending' and expires_at > now() order by id desc limit 1`;
  const [o] = await db()`select code from orders where id = ${orderId}`;
  const messages = p
    ? paymentMessages(p as PaymentRow, o.code, (p as PaymentRow).provider !== "manual_pix")
    : (await chargeOrder(orderId, { document })).messages;
  for (const m of messages) await messageOrderCustomer(orderId, m);
  return orderPayments(orderId);
}

// Último pagamento dos pedidos deste contato (o robô responde "já paguei" e reenvia o código).
export async function contactPayment(contactId: number) {
  const [row] = await db()`
    select p.*, o.code as order_code from payments p join orders o on o.id = p.order_id
    join wa_contacts c on c.user_id = o.user_id
    where c.id = ${contactId} order by p.id desc limit 1`;
  if (!row) return null;
  const p = row as PaymentRow & { order_code: string };
  return {
    orderCode: p.order_code,
    status: p.status as "pending" | "paid" | "expired" | "cancelled" | "failed",
    automatic: p.provider !== "manual_pix",
    messages: p.status === "pending" ? paymentMessages(p, p.order_code, p.provider !== "manual_pix") : [],
  };
}

export { ProviderError };
