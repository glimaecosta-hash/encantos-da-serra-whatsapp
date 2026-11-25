import { db } from "../db";
import { config } from "../config";
import { describeRegion, regionForCep } from "./delivery";
import { createOrder, getOrder, type Address, type ItemInput } from "./checkout";
import { findProduct, listProducts, type ProductDto } from "./products";
import { hashPassword } from "../lib/auth";
import { AppError, badRequest, conflict, notFound } from "../lib/errors";
import { onlyDigits, randomToken } from "../lib/text";
import Anthropic from "@anthropic-ai/sdk";
import { runAgent, type AgentOptions, type CatalogProduct, type HistoryItem } from "../lib/agent";
import { brl, ORDER_STATUS_LABEL, runBot, siteCartFromMessage, type BotData, type BotDeps, type BotMessage, type BotProduct, type BotResult, type Handoff } from "../lib/bot";
import { sendWhatsApp } from "../lib/whatsapp";
import { activeNeedsDocument, chargeOrder, contactPayment } from "./payments";
import { botConfigFor, logQuestion } from "./botCentral";
import type { AuthUser } from "../lib/types";

// Atendimento pelo WhatsApp: entrada de mensagens, chatbot, fila dos responsáveis e pedidos fechados na conversa.

export const STAGES = ["bot", "waiting", "negotiating", "awaiting_customer", "won", "lost"] as const;
export type Stage = (typeof STAGES)[number];
export const TOPICS = ["compra", "atacado", "pedido", "duvida", "reclamacao"] as const;
const OPEN_STAGES = ["bot", "waiting", "negotiating", "awaiting_customer"];

export function normalizePhone(phone: string): string {
  let d = onlyDigits(phone);
  if (d.length === 10 || d.length === 11) d = `55${d}`; // número brasileiro sem DDI
  if (d.length < 12 || d.length > 13) throw badRequest("Telefone inválido: use DDD + número");
  return d;
}

export function formatPhone(phone: string): string {
  const m = phone.match(/^55(\d{2})(\d{4,5})(\d{4})$/);
  return m ? `(${m[1]}) ${m[2]}-${m[3]}` : `+${phone}`;
}

// ---------- contato e conversa ----------

async function upsertContact(phone: string, name?: string | null) {
  const [c] = await db()`
    insert into wa_contacts (phone, name) values (${phone}, ${name?.trim() || null})
    on conflict (phone) do update set name = coalesce(wa_contacts.name, excluded.name), updated_at = now()
    returning id, phone, name, user_id as "userId", business_name as "businessName"`;
  return c as { id: number; phone: string; name: string | null; userId: number | null; businessName: string | null };
}

async function openConversation(contactId: number) {
  const [existing] = await db()`select * from conversations where contact_id = ${contactId} and closed_at is null`;
  if (existing) return existing;
  const [created] = await db()`
    insert into conversations (contact_id) values (${contactId})
    on conflict (contact_id) where closed_at is null do update set last_message_at = conversations.last_message_at
    returning *`;
  return created;
}

type MessageMeta = { engine: "ia" | "regras"; trace: string[]; state: string; handoff?: string };

async function addMessage(
  conversationId: number, author: string, body: string,
  opts: { agentId?: number | null; options?: unknown; status?: "sent" | "pending"; meta?: MessageMeta } = {},
) {
  const [m] = await db()`
    insert into conversation_messages (conversation_id, author, agent_id, body, options, status, meta)
    values (${conversationId}, ${author}, ${opts.agentId ?? null}, ${body}, ${opts.options ? JSON.stringify(opts.options) : null}::text::jsonb,
            ${opts.status ?? "sent"}, ${opts.meta ? JSON.stringify(opts.meta) : null}::text::jsonb)
    returning id`;
  await db()`update conversations set last_message_at = now() where id = ${conversationId}`;
  return m.id as number;
}

// Mensagem que vai para o cliente: grava na conversa e entrega pelo transporte (simulador hoje; API do WhatsApp depois).
// Com `hold` (modo supervisionado), fica como rascunho até a equipe aprovar.
async function sendToCustomer(conversationId: number, phone: string, author: "bot" | "agent", msg: BotMessage, agentId?: number, opts: { hold?: boolean; meta?: MessageMeta } = {}) {
  await addMessage(conversationId, author, msg.body, { agentId, options: msg.options, status: opts.hold ? "pending" : "sent", meta: opts.meta });
  if (!opts.hold) await sendWhatsApp(phone, msg);
}

// ---------- modo supervisionado ----------

export async function attendanceSettings(): Promise<{ supervised: boolean }> {
  const [row] = await db()`select value from site_settings where key = 'attendance'`;
  const v = typeof row?.value === "string" ? JSON.parse(row.value) : row?.value;
  return { supervised: !!v?.supervised };
}

export async function setSupervised(supervised: boolean) {
  await db()`
    insert into site_settings (key, value) values ('attendance', ${JSON.stringify({ supervised })}::text::jsonb)
    on conflict (key) do update set value = excluded.value`;
  return attendanceSettings();
}

// Aprova um rascunho do robô (ou todos, sem messageId); com `body`, envia a versão editada pela equipe.
export async function approvePending(id: number, agent: AuthUser, messageId?: number, body?: string) {
  const cv = await loadForAction(id);
  const rows = messageId
    ? await db()`select id, body, options from conversation_messages where id = ${messageId} and conversation_id = ${id} and status = 'pending'`
    : await db()`select id, body, options from conversation_messages where conversation_id = ${id} and status = 'pending' order by id`;
  if (!rows.length) throw conflict("Não há resposta esperando aprovação");
  for (const r of rows) {
    const edited = messageId && body && body.trim() !== r.body ? body.trim() : null;
    await db()`
      update conversation_messages set status = 'sent', body = ${edited ?? r.body}, approval = ${edited ? "edited" : "approved"}, approved_by = ${agent.id}
      where id = ${r.id}`;
    await sendWhatsApp(cv.phone, { body: edited ?? r.body, options: edited ? undefined : (typeof r.options === "string" ? JSON.parse(r.options) : r.options ?? undefined) });
  }
}

// Descarta rascunhos do robô. Descartar todos = a equipe assume e responde do seu jeito.
export async function discardPending(id: number, agent: AuthUser, messageId?: number) {
  await loadForAction(id);
  const rows = messageId
    ? await db()`update conversation_messages set status = 'discarded', approval = 'discarded', approved_by = ${agent.id} where id = ${messageId} and conversation_id = ${id} and status = 'pending' returning id`
    : await db()`update conversation_messages set status = 'discarded', approval = 'discarded', approved_by = ${agent.id} where conversation_id = ${id} and status = 'pending' returning id`;
  if (!rows.length) throw conflict("Não há resposta esperando aprovação");
  if (!messageId) await assume(id, agent);
}

// ---------- avaliação e validação ----------

export async function rateMessage(id: number, messageId: number, agent: AuthUser, rating: "good" | "bad" | null, note?: string) {
  const [m] = await db()`
    update conversation_messages set rating = ${rating}, rating_note = ${rating === "bad" ? note?.trim() || null : null}, rated_by = ${rating ? agent.id : null}
    where id = ${messageId} and conversation_id = ${id} and author = 'bot' returning id`;
  if (!m) throw notFound("Mensagem do robô");
}

export async function reviewConversation(id: number, agent: AuthUser, review: "ok" | "corrigida" | "problema" | null, note?: string) {
  await loadForAction(id);
  await db()`
    update conversations set review = ${review}, review_note = ${review ? note?.trim() || null : null},
      reviewed_by = ${review ? agent.id : null}, reviewed_at = ${review ? new Date() : null}
    where id = ${id}`;
}

// Usuário "sombra" para o contato poder ter pedidos (orders.user_id é obrigatório).
async function ensureContactUser(contact: { id: number; phone: string; name: string | null; userId: number | null }, role: "customer" | "business" = "customer"): Promise<AuthUser> {
  if (contact.userId) {
    const [u] = await db()`select id, name, email, role from users where id = ${contact.userId}`;
    if (u) {
      if (role === "business" && u.role === "customer") await db()`update users set role = 'business' where id = ${u.id}`;
      return { ...u, role: role === "business" && u.role === "customer" ? "business" : u.role } as AuthUser;
    }
  }
  const email = `whatsapp+${contact.phone}@clientes.encantos`;
  const [u] = await db()`
    insert into users (name, email, password_hash, phone, role)
    values (${contact.name ?? formatPhone(contact.phone)}, ${email}, ${await hashPassword(randomToken(24))}, ${contact.phone}, ${role})
    on conflict (email) do update set name = excluded.name
    returning id, name, email, role`;
  await db()`update wa_contacts set user_id = ${u.id} where id = ${contact.id}`;
  return u as AuthUser;
}

// ---------- dependências do bot ----------

const toBotProduct = (p: ProductDto): BotProduct => ({
  id: p.id,
  sku: p.sku,
  name: p.name,
  unitLabel: p.retail.unitLabel,
  weightGrams: p.weightGrams,
  priceCents: p.retail.priceCents,
  availableUnits: p.stock.units,
});

// Só produtos ativos chegam ao cliente pelo bot.
async function activeProduct(by: { id?: number; sku?: string }): Promise<BotProduct | null> {
  const p = await findProduct(by);
  if (!p) return null;
  const [row] = await db()`select active from products where id = ${p.id}`;
  return row?.active ? toBotProduct(p) : null;
}

async function whatsappSettings(): Promise<{ number: string; displayNumber: string; hours: string }> {
  const [row] = await db()`select value from site_settings where key = 'whatsapp'`;
  const v = typeof row?.value === "string" ? JSON.parse(row.value) : row?.value;
  return { number: "", displayNumber: "", hours: "Seg a sex, 8h às 18h", ...(v ?? {}) };
}

// ---------- robô com IA ----------

let anthropic: Anthropic | null = null;

// Configuração da IA, ou null quando ela está desligada (sem ANTHROPIC_API_KEY ou AI_ENABLED=false).
export function aiOptions(): AgentOptions | null {
  const c = config();
  if (!c.AI_ENABLED || !c.ANTHROPIC_API_KEY) return null;
  anthropic ??= new Anthropic({ apiKey: c.ANTHROPIC_API_KEY, timeout: 60_000, maxRetries: 1 });
  const client = anthropic;
  return { model: c.AI_MODEL, effort: c.AI_EFFORT, create: (params) => client.beta.messages.create(params) };
}

export const botMode = () => {
  const ai = aiOptions();
  return ai ? { mode: "ia" as const, model: ai.model } : { mode: "regras" as const, model: null };
};

const MILK_TYPES = new Set(["vaca", "cabra", "bufala", "misto"]);

async function catalogForAgent(): Promise<CatalogProduct[]> {
  const { items } = await listProducts({ pageSize: 200, sort: "name" });
  return items.map((p) => ({
    sku: p.sku,
    name: p.name,
    category: p.category.name,
    producer: p.producer.name,
    origin: `${p.producer.city}/${p.producer.state}`,
    milk: MILK_TYPES.has(p.milkType) ? p.milkType : String(p.milkType),
    cureDays: p.cureDays,
    weightGrams: p.weightGrams,
    unitLabel: p.retail.unitLabel,
    priceCents: p.retail.priceCents,
    description: p.description,
    detail: p.detailTag,
    badge: p.awarded ? p.badge : null,
  }));
}

function botDeps(contact: Awaited<ReturnType<typeof upsertContact>>, conversationId: number, hours: string, needsDocument = false): BotDeps {
  return {
    hours,
    needsDocument,
    lastPayment: () => contactPayment(contact.id),
    categories: async () => db()`
      select c.slug, c.name from categories c
      where exists (select 1 from products p where p.category_id = c.id and p.active) order by c.sort_order`,
    products: async (slug) => (await listProducts({ category: slug, pageSize: 30, sort: "best_sellers" })).items.map(toBotProduct),
    productById: async (id) => activeProduct({ id }),
    productBySku: async (sku) => activeProduct({ sku }),
    quoteCep: async (cep) => {
      try {
        const region = await regionForCep(cep);
        const d = describeRegion(region, 1);
        const next = d.nextDelivery;
        const [y, m, dd] = next?.date.split("-") ?? [];
        return { ok: true, region: d.region, feeCents: d.feeCents, freeShippingOverCents: d.freeShippingOverCents, nextDelivery: next?.date ?? null, nextDeliveryLabel: next ? `${next.weekday}, ${dd}/${m}/${y}` : null };
      } catch (e) {
        return { ok: false, message: e instanceof AppError ? e.message : "Não consegui consultar esse CEP" };
      }
    },
    placeOrder: async ({ cart, cep, address, discountCents }) => {
      try {
        const fresh = { ...contact, name: contact.name ?? address.recipient };
        if (!contact.name) await db()`update wa_contacts set name = ${address.recipient} where id = ${contact.id}`;
        const user = await ensureContactUser(fresh);
        const order = await createOrder({
          user,
          items: cart.map((l) => ({ productId: l.productId, mode: "unit" as const, quantity: l.quantity })),
          cep,
          address,
          source: "whatsapp",
          conversationId,
          discountCents,
          firstEvent: `Pedido feito pelo WhatsApp (chatbot${discountCents ? `, com desconto de ${brl(discountCents)} dentro do limite da Central do Robô` : ""}). Aguardando confirmação do pagamento.`,
        });
        return { ok: true, code: order.code, totalCents: order.totalCents, shippingCents: order.shippingCents, scheduledDelivery: order.scheduledDelivery };
      } catch (e) {
        if (e instanceof AppError) return { ok: false, message: e.message };
        throw e;
      }
    },
    recentOrders: async () => {
      const rows = await db()`
        select o.code, o.status, o.total_cents as "totalCents", o.scheduled_delivery::text as "scheduledDelivery", o.created_at as "createdAt"
        from orders o join users u on u.id = o.user_id
        left join wa_contacts c on c.user_id = u.id
        where c.id = ${contact.id} or u.phone = ${contact.phone}
        order by o.created_at desc limit 3`;
      return rows.map((r: any) => ({ ...r, createdAt: new Date(r.createdAt).toISOString() }));
    },
  };
}

// ---------- entrada de mensagem (webhook / simulador) ----------

export async function handleInbound(input: { phone: string; name?: string | null; text: string; useDraft?: boolean }) {
  const phone = normalizePhone(input.phone);
  const text = input.text.trim().slice(0, 2000);
  if (!text) throw badRequest("Mensagem vazia");
  const contact = await upsertContact(phone, input.name);
  const conv = await openConversation(contact.id);

  await addMessage(conv.id, "customer", text);
  // Cliente respondeu: some da coluna "aguardando cliente" e volta para quem atende.
  await db()`
    update conversations set
      unread_count = case when mode = 'human' then unread_count + 1 else unread_count end,
      last_customer_at = now(),
      stage = case when stage = 'awaiting_customer' then 'negotiating' else stage end
    where id = ${conv.id}`;

  if (conv.mode === "human") return { conversationId: conv.id, handled: "human" as const };

  const settings = await whatsappSettings();
  const data: BotData = typeof conv.bot_data === "string" ? JSON.parse(conv.bot_data) : conv.bot_data;
  // Central do Robô: clientes usam a versão publicada; o Simulador pode testar o rascunho.
  const deps = { ...botDeps(contact, conv.id, settings.hours, await activeNeedsDocument()), config: await botConfigFor(input.useDraft) };

  // Com a IA ligada, ela conduz a conversa. O carrinho vindo do site continua com o robô de regras
  // (é exato e não custa nada); a IA segue a partir dali. Se a IA falhar, o robô de regras responde.
  let result: BotResult | null = null;
  let trace: string[] = [];
  const ai = aiOptions();
  if (ai && !siteCartFromMessage(text)) {
    try {
      const history = (await db()`
        select author, body from conversation_messages
        where conversation_id = ${conv.id} and author in ('customer', 'bot', 'agent') and status = 'sent'
        order by id desc limit 30`).reverse() as HistoryItem[];
      const today = new Intl.DateTimeFormat("pt-BR", { timeZone: config().TZ_BUSINESS, weekday: "long", day: "2-digit", month: "2-digit", year: "numeric" }).format(new Date());
      const r = await runAgent({ history, data, contactName: contact.name, today }, { ...deps, catalog: catalogForAgent }, ai);
      result = r;
      trace = r.trace;
      console.info(`[ia] conversa ${conv.id}: ${r.usage.requests} chamadas, entrada ${r.usage.input} (+${r.usage.cacheRead} cache), saída ${r.usage.output}`);
    } catch (e) {
      console.error(`[ia] conversa ${conv.id}: falhou, usando o robô de regras —`, e instanceof Error ? e.message : e);
    }
  }
  result ??= await runBot({ state: conv.bot_state, data, text, contactName: contact.name }, deps);

  // Modo supervisionado: as respostas do robô (e o Pix) esperam a equipe aprovar.
  const hold = (await attendanceSettings()).supervised;
  // "Por que respondeu isso": motor, o que consultou e a etapa, guardados na primeira mensagem da resposta.
  const meta: MessageMeta = { engine: trace.length || result.state === "ai" ? "ia" : "regras", trace, state: result.state, handoff: result.handoff?.reason };
  for (const [i, m] of result.messages.entries()) await sendToCustomer(conv.id, phone, "bot", m, undefined, { hold, meta: i === 0 ? meta : undefined });
  if (result.customerName && !contact.name) await db()`update wa_contacts set name = ${result.customerName} where id = ${contact.id}`;
  // Pergunta que o robô não soube responder: vai para a Central do Robô (não pode travar o atendimento).
  if (result.unanswered) await logQuestion(result.unanswered, conv.id, trace.length ? "ia" : "robo").catch((e) => console.error("[central] pergunta:", e));

  await db()`update conversations set bot_state = ${result.state}, bot_data = ${JSON.stringify(result.data)}::text::jsonb where id = ${conv.id}`;

  if (result.orderCode) {
    const [o] = await db()`select id from orders where code = ${result.orderCode}`;
    await db()`update conversations set order_id = ${o.id}, topic = 'compra' where id = ${conv.id}`;
    await addMessage(conv.id, "system", `Pedido ${result.orderCode} criado pelo ${trace.length ? "robô com IA" : "chatbot"}.`);
    // Cobrança automática (Pix + link de cartão). Se o provedor falhar, a equipe assume o pagamento.
    try {
      const { payment, messages } = await chargeOrder(o.id, { document: result.data.document });
      for (const m of messages) await sendToCustomer(conv.id, phone, "bot", m, undefined, { hold });
      await addMessage(conv.id, "system", `Pagamento enviado ao cliente (${payment.provider === "manual_pix" ? "Pix copia e cola da loja" : payment.provider}), ${brl(payment.amount_cents)}.`);
    } catch (e) {
      const why = e instanceof Error ? e.message : "erro desconhecido";
      console.error(`[pagamentos] pedido ${result.orderCode}:`, why);
      await addMessage(conv.id, "system", `Não consegui gerar o pagamento: ${why}`);
      await sendToCustomer(conv.id, phone, "bot", { body: "Uma pessoa da equipe vai te enviar os dados de pagamento por aqui em instantes. 🙏" }, undefined, { hold });
      await escalate(conv.id, { topic: "compra", reason: `Pedido ${result.orderCode}: gerar o pagamento (${why})` });
    }
  }
  if (result.handoff) await escalate(conv.id, result.handoff);
  return { conversationId: conv.id, handled: hold ? ("pending_approval" as const) : ("bot" as const) };
}

async function escalate(conversationId: number, h: Handoff) {
  await db()`
    update conversations set mode = 'human', stage = 'waiting', topic = ${h.topic},
      waiting_since = coalesce(waiting_since, now()), unread_count = greatest(unread_count, 1)
    where id = ${conversationId}`;
  await addMessage(conversationId, "system", `Transferido para atendente: ${h.reason}`);
}

// ---------- painel: fila e conversa ----------

const LIST_COLUMNS = `
  cv.id, cv.stage, cv.mode, cv.topic, cv.unread_count as "unreadCount", cv.last_message_at as "lastMessageAt",
  cv.waiting_since as "waitingSince", cv.created_at as "createdAt", cv.closed_at as "closedAt",
  ct.id as "contactId", ct.phone, ct.name, ct.business_name as "businessName",
  u.name as "assignedName", cv.assigned_to as "assignedTo",
  o.code as "orderCode", o.total_cents as "orderTotalCents",
  cv.review,
  (select count(*) from conversation_messages m where m.conversation_id = cv.id and m.status = 'pending')::int as "pendingApproval",
  (select json_build_object('author', m.author, 'body', left(m.body, 140), 'at', m.created_at, 'status', m.status)
     from conversation_messages m where m.conversation_id = cv.id and m.author not in ('note', 'system') and m.status <> 'discarded'
     order by m.id desc limit 1) as "lastMessage"`;

// Conversa com resposta do robô esperando aprovação também precisa da equipe.
const NEEDS_YOU = `((cv.stage in ('waiting', 'negotiating') and (cv.unread_count > 0 or cv.stage = 'waiting'))
  or exists (select 1 from conversation_messages pm where pm.conversation_id = cv.id and pm.status = 'pending'))`;

// Para a tela "Hoje": quantas conversas precisam da equipe e as mais antigas esperando.
export async function needsYou() {
  const rows = await db().unsafe(`
    select cv.id, ct.name, ct.phone, cv.topic, cv.waiting_since as "waitingSince",
      (select count(*) from conversation_messages pm where pm.conversation_id = cv.id and pm.status = 'pending')::int as "pendingApproval"
    from conversations cv join wa_contacts ct on ct.id = cv.contact_id
    where ${NEEDS_YOU}
    order by coalesce(cv.waiting_since, cv.last_message_at) limit 50`);
  return { count: rows.length, items: rows.slice(0, 6).map((r: any) => ({ ...r, phoneLabel: formatPhone(r.phone) })) };
}

export async function listConversations(f: { view: string; q?: string; userId: number }) {
  const params: unknown[] = [];
  const where: string[] = [];
  switch (f.view) {
    case "attention": where.push(NEEDS_YOU); break;
    case "approval": where.push(`exists (select 1 from conversation_messages pm where pm.conversation_id = cv.id and pm.status = 'pending')`); break;
    case "mine": params.push(f.userId); where.push(`cv.assigned_to = $${params.length} and cv.closed_at is null`); break;
    case "closed": where.push(`cv.stage in ('won', 'lost')`); break;
    case "open": where.push(`cv.closed_at is null`); break;
    default:
      if ((STAGES as readonly string[]).includes(f.view)) { params.push(f.view); where.push(`cv.stage = $${params.length}`); }
  }
  if (f.q?.trim()) {
    params.push(`%${f.q.trim().toLowerCase()}%`);
    const i = params.length;
    where.push(`(lower(coalesce(ct.name, '')) like $${i} or ct.phone like $${i} or lower(coalesce(ct.business_name, '')) like $${i} or lower(coalesce(o.code, '')) like $${i})`);
  }
  const rows = await db().unsafe(`
    select ${LIST_COLUMNS}
    from conversations cv join wa_contacts ct on ct.id = cv.contact_id
    left join users u on u.id = cv.assigned_to left join orders o on o.id = cv.order_id
    ${where.length ? `where ${where.join(" and ")}` : ""}
    order by exists (select 1 from conversation_messages pm where pm.conversation_id = cv.id and pm.status = 'pending') desc,
      (cv.stage = 'waiting') desc, (cv.unread_count > 0) desc, cv.last_message_at desc
    limit 200`, params);

  const [counts] = await db().unsafe(`
    select
      count(*) filter (where cv.closed_at is null)::int as open,
      count(*) filter (where ${NEEDS_YOU})::int as attention,
      count(*) filter (where exists (select 1 from conversation_messages pm where pm.conversation_id = cv.id and pm.status = 'pending'))::int as approval,
      count(*) filter (where cv.assigned_to = $1 and cv.closed_at is null)::int as mine,
      count(*) filter (where cv.stage = 'bot')::int as bot,
      count(*) filter (where cv.stage = 'waiting')::int as waiting,
      count(*) filter (where cv.stage = 'negotiating')::int as negotiating,
      count(*) filter (where cv.stage = 'awaiting_customer')::int as awaiting_customer,
      count(*) filter (where cv.stage in ('won', 'lost'))::int as closed
    from conversations cv`, [f.userId]);
  return { conversations: rows.map(withPhoneLabel), counts };
}

function withPhoneLabel<T extends { phone: string; lastMessage?: unknown }>(r: T) {
  return { ...r, phoneLabel: formatPhone(r.phone), lastMessage: typeof r.lastMessage === "string" ? JSON.parse(r.lastMessage) : r.lastMessage };
}

export async function getConversation(id: number) {
  const [cv] = await db().unsafe(`
    select ${LIST_COLUMNS}, cv.bot_state as "botState", cv.bot_data as "botData", cv.lost_reason as "lostReason",
           cv.first_human_reply_at as "firstHumanReplyAt", ct.notes as "contactNotes", ct.user_id as "userId", cv.order_id as "orderId",
           cv.review_note as "reviewNote", cv.reviewed_at as "reviewedAt", (select name from users where id = cv.reviewed_by) as "reviewedBy"
    from conversations cv join wa_contacts ct on ct.id = cv.contact_id
    left join users u on u.id = cv.assigned_to left join orders o on o.id = cv.order_id
    where cv.id = $1`, [id]);
  if (!cv) throw notFound("Conversa");
  const [messages, orders, history] = await Promise.all([
    db()`
      select m.id, m.author, m.body, m.options, m.created_at as "createdAt", u.name as "agentName",
             m.status, m.meta, m.approval, m.rating, m.rating_note as "ratingNote", a.name as "approvedBy"
      from conversation_messages m left join users u on u.id = m.agent_id left join users a on a.id = m.approved_by
      where m.conversation_id = ${id} order by m.id`,
    db()`
      select o.code, o.status, o.total_cents as "totalCents", o.discount_cents as "discountCents", o.source, o.created_at as "createdAt",
             o.scheduled_delivery::text as "scheduledDelivery"
      from orders o join wa_contacts c on c.user_id = o.user_id
      where c.id = ${cv.contactId} order by o.created_at desc limit 10`,
    db()`
      select id, stage, topic, created_at as "createdAt", closed_at as "closedAt"
      from conversations where contact_id = ${cv.contactId} and id <> ${id} order by created_at desc limit 10`,
  ]);
  const botData = typeof cv.botData === "string" ? JSON.parse(cv.botData) : cv.botData;
  return {
    conversation: { ...withPhoneLabel(cv), botData },
    messages: messages.map((m: any) => ({
      ...m,
      options: typeof m.options === "string" ? JSON.parse(m.options) : m.options,
      meta: typeof m.meta === "string" ? JSON.parse(m.meta) : m.meta,
    })),
    orders,
    history,
  };
}

async function loadForAction(id: number) {
  const [cv] = await db()`
    select cv.*, ct.phone from conversations cv join wa_contacts ct on ct.id = cv.contact_id where cv.id = ${id}`;
  if (!cv) throw notFound("Conversa");
  return cv;
}

export async function agentReply(id: number, agent: AuthUser, body: string) {
  const cv = await loadForAction(id);
  if (cv.closed_at) throw conflict("Conversa encerrada. O cliente abre uma nova ao mandar mensagem.");
  // Responsável escreveu: a conversa passa a ser dele e o bot fica em silêncio.
  await db()`
    update conversations set mode = 'human', assigned_to = coalesce(assigned_to, ${agent.id}),
      first_human_reply_at = coalesce(first_human_reply_at, now()), unread_count = 0,
      stage = case when stage in ('bot', 'waiting', 'negotiating') then 'awaiting_customer' else stage end
    where id = ${id}`;
  await sendToCustomer(id, cv.phone, "agent", { body }, agent.id);
}

export async function addNote(id: number, agent: AuthUser, body: string) {
  await loadForAction(id);
  await addMessage(id, "note", body, { agentId: agent.id });
}

export async function assume(id: number, agent: AuthUser) {
  const cv = await loadForAction(id);
  if (cv.closed_at) throw conflict("Conversa encerrada");
  await db()`
    update conversations set mode = 'human', assigned_to = ${agent.id}, unread_count = 0,
      stage = case when stage in ('bot', 'waiting') then 'negotiating' else stage end,
      waiting_since = coalesce(waiting_since, now())
    where id = ${id}`;
  await addMessage(id, "system", `${agent.name} assumiu o atendimento`);
}

export async function releaseToBot(id: number, agent: AuthUser) {
  const cv = await loadForAction(id);
  if (cv.closed_at) throw conflict("Conversa encerrada");
  await db()`
    update conversations set mode = 'bot', stage = 'bot', bot_state = 'menu', unread_count = 0, waiting_since = null
    where id = ${id}`;
  await addMessage(id, "system", `${agent.name} devolveu a conversa ao chatbot`);
  await sendToCustomer(id, cv.phone, "bot", { body: "Se precisar de mais alguma coisa, digite *menu* que eu te ajudo. 😊" });
}

export async function markRead(id: number) {
  await db()`update conversations set unread_count = 0 where id = ${id}`;
}

export async function setStage(id: number, agent: AuthUser, stage: Stage, lostReason?: string) {
  const cv = await loadForAction(id);
  if (stage === "lost" && !lostReason?.trim()) throw badRequest("Informe o motivo para encerrar sem pedido");
  if (stage === "won" && !cv.order_id) throw badRequest("Para marcar como fechado, gere o pedido pela conversa");
  if (stage === "bot") return releaseToBot(id, agent);
  const closing = stage === "won" || stage === "lost";
  await db()`
    update conversations set stage = ${stage}, lost_reason = ${stage === "lost" ? lostReason!.trim() : null},
      mode = ${closing ? cv.mode : "human"}, assigned_to = coalesce(assigned_to, ${agent.id}),
      closed_at = ${closing ? new Date() : null}, unread_count = ${closing ? 0 : cv.unread_count}
    where id = ${id}`;
  const label: Record<string, string> = { waiting: "Aguardando atendente", negotiating: "Em atendimento", awaiting_customer: "Aguardando cliente", won: "Fechada com pedido", lost: "Encerrada sem pedido" };
  await addMessage(id, "system", `${agent.name} moveu para "${label[stage]}"${stage === "lost" ? ` — motivo: ${lostReason}` : ""}`);
}

export async function updateContact(id: number, patch: { name?: string; businessName?: string | null; notes?: string | null }) {
  const cv = await loadForAction(id);
  await db()`
    update wa_contacts set
      name = coalesce(${patch.name ?? null}, name),
      business_name = ${patch.businessName === undefined ? null : patch.businessName}::text,
      notes = ${patch.notes === undefined ? null : patch.notes}::text,
      updated_at = now()
    where id = ${cv.contact_id}`;
}

// Pedido fechado pelo responsável na conversa (preço negociado vira desconto; caixa liberada para atacado).
export async function orderFromConversation(id: number, agent: AuthUser, input: { items: ItemInput[]; discountCents: number; cep: string; address: Address; notes?: string }) {
  const cv = await loadForAction(id);
  const [contact] = await db()`select id, phone, name, user_id as "userId" from wa_contacts where id = ${cv.contact_id}`;
  const hasBoxes = input.items.some((i) => i.mode === "box");
  const user = await ensureContactUser(contact, hasBoxes ? "business" : "customer");
  const order = await createOrder({
    user,
    items: input.items,
    cep: input.cep,
    address: input.address,
    notes: input.notes,
    source: "whatsapp",
    conversationId: id,
    discountCents: input.discountCents,
    allowBoxes: true,
    firstEvent: `Pedido fechado no WhatsApp por ${agent.name}. Aguardando confirmação do pagamento.`,
  });
  await db()`
    update conversations set order_id = ${order.id}, stage = 'won', closed_at = now(), mode = 'human',
      assigned_to = coalesce(assigned_to, ${agent.id}), first_human_reply_at = coalesce(first_human_reply_at, now()), unread_count = 0
    where id = ${id}`;
  await addMessage(id, "system", `${agent.name} fechou o pedido ${order.code} (${brl(order.totalCents)})`);
  const lines = (order.items as any[]).map((i) => `• ${i.quantity}${i.mode === "box" ? " cx" : "×"} ${i.productName} — ${brl(i.totalCents)}`).join("\n");
  await sendToCustomer(id, cv.phone, "agent", {
    body: `✅ *Pedido ${order.code} registrado!*\n\n${lines}\n` +
      (order.discountCents ? `Desconto: −${brl(order.discountCents)}\n` : "") +
      `Frete: ${order.shippingCents ? brl(order.shippingCents) : "grátis"}\n*Total: ${brl(order.totalCents)}*` +
      (order.scheduledDelivery ? `\nEntrega prevista: ${order.scheduledDelivery.split("-").reverse().slice(0, 2).join("/")}` : "") +
      `\n\nVocê recebe as atualizações do pedido por aqui.`,
  }, agent.id);
  // Cobrança do pedido fechado pelo responsável. Se falhar, ele vê o motivo e usa "Reenviar pagamento" em Pedidos.
  try {
    const { messages } = await chargeOrder(order.id);
    for (const m of messages) await sendToCustomer(id, cv.phone, "agent", m, agent.id);
  } catch (e) {
    await addMessage(id, "system", `Pagamento não foi gerado: ${e instanceof Error ? e.message : "erro desconhecido"}. Combine com o cliente ou use "Reenviar pagamento" em Pedidos.`);
  }
  return order;
}

// Mensagem para o cliente do pedido, na conversa mais recente dele (avisos de pagamento e de status).
export async function messageOrderCustomer(orderId: number, msg: BotMessage) {
  const [row] = await db()`
    select c.phone, c.id as "contactId"
    from orders o join wa_contacts c on c.user_id = o.user_id where o.id = ${orderId}`;
  if (!row) return false;
  const [conv] = await db()`select id from conversations where contact_id = ${row.contactId} order by (closed_at is null) desc, id desc limit 1`;
  if (!conv) return false;
  await sendToCustomer(conv.id, row.phone, "bot", msg);
  return true;
}

// Atualização de status do pedido → aviso automático no WhatsApp do cliente.
export async function notifyOrderStatus(orderId: number, status: string, message: string) {
  const [row] = await db()`select code from orders where id = ${orderId}`;
  if (!row) return;
  const label = ORDER_STATUS_LABEL[status] ?? status;
  const same = (x: string) => x.toLowerCase().replace(/[^a-zà-ú ]/g, "").trim();
  const extra = same(message) && !same(label).includes(same(message)) && !same(message).includes(same(label)) ? message.trim() : "";
  const icon: Record<string, string> = { confirmed: "💳", preparing: "🧊", in_transit: "🚚", delivered: "✅", cancelled: "❌" };
  // A mensagem do responsável só entra quando acrescenta algo ao texto padrão da etapa.
  await messageOrderCustomer(orderId, { body: `${icon[status] ?? "📦"} *Pedido ${row.code}*: ${label}.${extra ? `\n${extra}` : ""}` });
}

// ---------- simulador ----------

export async function simulatorThread(phoneRaw: string) {
  const phone = normalizePhone(phoneRaw);
  const messages = await db()`
    select m.id, m.author, m.body, m.options, m.created_at as "createdAt"
    from conversation_messages m join conversations cv on cv.id = m.conversation_id join wa_contacts c on c.id = cv.contact_id
    where c.phone = ${phone} and m.author in ('customer', 'bot', 'agent') and m.status = 'sent'
    order by m.id desc limit 200`;
  return messages.reverse().map((m: any) => ({ ...m, options: typeof m.options === "string" ? JSON.parse(m.options) : m.options }));
}

export async function simulatorContacts() {
  return (await db()`
    select c.phone, c.name, max(m.created_at) as "lastAt"
    from wa_contacts c join conversations cv on cv.contact_id = c.id join conversation_messages m on m.conversation_id = cv.id
    group by c.id order by 3 desc limit 20`).map((r: any) => ({ ...r, phoneLabel: formatPhone(r.phone) }));
}

export { OPEN_STAGES, whatsappSettings, getOrder };
