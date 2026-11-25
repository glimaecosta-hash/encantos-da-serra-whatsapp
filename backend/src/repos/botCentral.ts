import { db } from "../db";
import { DEFAULT_BOT_CONFIG, withDefaults, type BotConfig } from "../lib/botConfig";
import { badRequest, notFound } from "../lib/errors";
import { normalize } from "../lib/text";

// Central do Robô: rascunho x publicado, histórico de versões e perguntas sem resposta.

type Version = { config: BotConfig; publishedAt: string; publishedBy: string };
type Stored = { draft: BotConfig; published: BotConfig; publishedAt: string | null; publishedBy: string | null; versions: Version[] };

const MAX_VERSIONS = 10;

async function load(): Promise<Stored> {
  const [row] = await db()`select value from site_settings where key = 'bot_config'`;
  const v = typeof row?.value === "string" ? JSON.parse(row.value) : row?.value;
  return {
    draft: withDefaults(v?.draft ?? v?.published),
    published: withDefaults(v?.published),
    publishedAt: v?.publishedAt ?? null,
    publishedBy: v?.publishedBy ?? null,
    versions: (v?.versions ?? []).map((x: Version) => ({ ...x, config: withDefaults(x.config) })),
  };
}

async function save(s: Stored) {
  await db()`
    insert into site_settings (key, value) values ('bot_config', ${JSON.stringify(s)}::text::jsonb)
    on conflict (key) do update set value = excluded.value`;
}

// Cache curto: cada mensagem do WhatsApp lê a configuração; ela muda raramente.
let cache: { at: number; value: Stored } | null = null;
async function current() {
  if (cache && Date.now() - cache.at < 10_000) return cache.value;
  cache = { at: Date.now(), value: await load() };
  return cache.value;
}
const invalidate = () => { cache = null; };

// Configuração usada numa conversa: a publicada, ou o rascunho quando é teste no Simulador.
export async function botConfigFor(useDraft = false): Promise<BotConfig> {
  const s = await current();
  return useDraft ? s.draft : s.published;
}

const same = (a: BotConfig, b: BotConfig) => JSON.stringify(a) === JSON.stringify(b);

export async function centralOverview() {
  const s = await load();
  const [{ open }] = await db()`select count(*)::int as open from bot_questions where status = 'open'`;
  const products = await db()`
    select p.sku, p.name, c.name as category from products p join categories c on c.id = p.category_id
    where p.active order by c.sort_order, p.name`;
  return {
    draft: s.draft,
    published: s.published,
    hasChanges: !same(s.draft, s.published),
    publishedAt: s.publishedAt,
    publishedBy: s.publishedBy,
    versions: s.versions.map((v, i) => ({ index: i, publishedAt: v.publishedAt, publishedBy: v.publishedBy })),
    openQuestions: open as number,
    products,
    defaults: DEFAULT_BOT_CONFIG,
  };
}

export async function saveDraft(config: BotConfig) {
  const s = await load();
  // Ficha de produto vazia não precisa ser guardada.
  const products = Object.fromEntries(Object.entries(config.products).filter(([, k]) => Object.values(k).some((v) => v.trim())));
  const ids = new Set<string>();
  for (const f of config.faqs) {
    if (ids.has(f.id)) throw badRequest("Pergunta frequente repetida");
    ids.add(f.id);
  }
  await save({ ...s, draft: withDefaults({ ...config, products }) });
  invalidate();
  return centralOverview();
}

export async function publish(userName: string) {
  const s = await load();
  const now = new Date().toISOString();
  // A versão que estava no ar vai para o histórico (para poder voltar).
  const versions = s.publishedAt ? [{ config: s.published, publishedAt: s.publishedAt, publishedBy: s.publishedBy ?? "" }, ...s.versions].slice(0, MAX_VERSIONS) : s.versions;
  await save({ ...s, published: s.draft, publishedAt: now, publishedBy: userName, versions });
  invalidate();
  return centralOverview();
}

export async function discardDraft() {
  const s = await load();
  await save({ ...s, draft: s.published });
  invalidate();
  return centralOverview();
}

// Volta uma versão antiga para o rascunho; os donos testam e publicam de novo.
export async function restoreVersion(index: number) {
  const s = await load();
  const v = s.versions[index];
  if (!v) throw notFound("Versão");
  await save({ ...s, draft: v.config });
  invalidate();
  return centralOverview();
}

// ---------- perguntas sem resposta ----------

const key = (q: string) => normalize(q).replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ").trim().slice(0, 200);

export async function logQuestion(question: string, conversationId: number | null, source: "robo" | "ia") {
  const q = question.trim().slice(0, 300);
  const n = key(q);
  if (n.length < 6) return;
  await db()`
    insert into bot_questions (question, normalized, conversation_id, source) values (${q}, ${n}, ${conversationId}, ${source})
    on conflict (normalized) where status = 'open'
    do update set times = bot_questions.times + 1, last_asked_at = now(), conversation_id = excluded.conversation_id`;
}

export async function listQuestions(status: "open" | "answered" | "ignored") {
  return db()`
    select q.id, q.question, q.source, q.status, q.times, q.answer, q.conversation_id as "conversationId",
           q.last_asked_at as "lastAskedAt", u.name as "answeredBy"
    from bot_questions q left join users u on u.id = q.answered_by
    where q.status = ${status} order by q.last_asked_at desc limit 100`;
}

type Teach = { question: string; answer: string; keywords: string[] };

// Ensinar ao robô: a resposta entra como pergunta frequente no rascunho (vale depois de publicar).
export async function teach(input: Teach, prefix = "t") {
  const s = await load();
  if (s.draft.faqs.length >= 100) throw badRequest("Limite de 100 perguntas frequentes. Junte ou remova algumas na Central do Robô.");
  const faq = { id: `${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`, question: input.question, answer: input.answer, keywords: input.keywords };
  await save({ ...s, draft: { ...s.draft, faqs: [...s.draft.faqs, faq] } });
  invalidate();
  return centralOverview();
}

// Responder = ensinar: a pergunta sai da lista e a resposta vira pergunta frequente no rascunho.
export async function answerQuestion(id: number, input: Teach, userId: number) {
  const [q] = await db()`update bot_questions set status = 'answered', answer = ${input.answer}, answered_by = ${userId} where id = ${id} returning id`;
  if (!q) throw notFound("Pergunta");
  return teach(input, `q${id}-`);
}

// ---------- qualidade do atendimento ----------

export async function qualityReport(days: number) {
  const since = new Date(Date.now() - days * 86_400_000);
  const [conv] = await db()`
    select count(*)::int as total,
      count(*) filter (where waiting_since is null and first_human_reply_at is null)::int as "botOnly",
      count(*) filter (where waiting_since is not null)::int as "handedOff",
      count(*) filter (where stage = 'won')::int as won,
      count(*) filter (where review = 'ok')::int as "reviewOk",
      count(*) filter (where review = 'corrigida')::int as "reviewFixed",
      count(*) filter (where review = 'problema')::int as "reviewProblem",
      percentile_cont(0.5) within group (order by extract(epoch from first_human_reply_at - waiting_since))
        filter (where first_human_reply_at is not null and waiting_since is not null and first_human_reply_at > waiting_since) as "medianWaitSec"
    from conversations where created_at >= ${since}`;
  const [msg] = await db()`
    select count(*) filter (where author = 'bot' and status = 'sent')::int as "botSent",
      count(*) filter (where author = 'bot' and meta->>'engine' = 'ia')::int as "aiTurns",
      count(*) filter (where author = 'bot' and meta->>'engine' = 'regras')::int as "rulesTurns",
      count(*) filter (where approval = 'approved')::int as approved,
      count(*) filter (where approval = 'edited')::int as edited,
      count(*) filter (where approval = 'discarded')::int as discarded,
      count(*) filter (where status = 'pending')::int as pending,
      count(*) filter (where rating = 'good')::int as good,
      count(*) filter (where rating = 'bad')::int as bad
    from conversation_messages where created_at >= ${since}`;
  const [orders] = await db()`
    select count(*) filter (where e.message like 'Pedido feito pelo WhatsApp (chatbot%')::int as "byBot",
           count(*) filter (where e.message like 'Pedido fechado no WhatsApp por%')::int as "byTeam"
    from orders o join lateral (select message from order_events where order_id = o.id order by id limit 1) e on true
    where o.source = 'whatsapp' and o.created_at >= ${since}`;
  const [questions] = await db()`
    select count(*) filter (where status = 'open')::int as open,
           count(*) filter (where status = 'answered' and last_asked_at >= ${since})::int as answered
    from bot_questions`;
  const badList = await db()`
    select m.id, m.body, m.rating_note as note, m.conversation_id as "conversationId", m.created_at as "createdAt", u.name as "ratedBy"
    from conversation_messages m left join users u on u.id = m.rated_by
    where m.rating = 'bad' and m.created_at >= ${since} order by m.id desc limit 10`;
  const problems = await db()`
    select cv.id, cv.review_note as note, cv.reviewed_at as "reviewedAt", ct.name, ct.phone
    from conversations cv join wa_contacts ct on ct.id = cv.contact_id
    where cv.review = 'problema' and cv.created_at >= ${since} order by cv.reviewed_at desc limit 10`;
  return {
    days,
    conversations: { ...conv, medianWaitSec: conv.medianWaitSec === null ? null : Math.round(Number(conv.medianWaitSec)) },
    messages: msg,
    orders,
    questions,
    badReplies: badList,
    problems,
  };
}

export async function ignoreQuestion(id: number) {
  const [q] = await db()`update bot_questions set status = 'ignored' where id = ${id} returning id`;
  if (!q) throw notFound("Pergunta");
}
