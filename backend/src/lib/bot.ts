import { containsKeyword, DEFAULT_BOT_CONFIG, matchFaq, renderGreeting, type BotConfig } from "./botConfig";
import { isValidCnpj, isValidCpf } from "./cnpj";
import { normalize, onlyDigits } from "./text";

// Chatbot do WhatsApp: máquina de estados pura. Recebe o texto do cliente e o estado salvo da conversa,
// devolve as respostas, o novo estado e — quando for o caso — o pedido de transferência para um responsável.
// Tudo o que depende do banco entra por `deps`, o que deixa o fluxo testável sem banco.

export type BotOption = { key: string; label: string };
export type BotMessage = { body: string; options?: BotOption[] };

export type CartLine = { productId: number; sku: string; name: string; unitLabel: string; priceCents: number; quantity: number };

export type BotAddress = { recipient?: string; street?: string; number?: string; district?: string; city?: string; state?: string; complement?: string };

export type BotData = {
  cart?: CartLine[];
  categorySlug?: string;
  pendingProductId?: number;
  list?: { id: number | string; label: string }[]; // itens numerados mostrados na última lista
  cep?: string;
  shipping?: { feeCents: number; freeShippingOverCents: number | null; region: string; nextDelivery: string | null };
  address?: BotAddress;
  fails?: number;
  returnTo?: string;
  // Robô com IA: número da mensagem do cliente e o resumo que ele já viu (trava antes de fechar o pedido).
  turn?: number;
  reviewed?: { key: string; turn: number };
  document?: string; // CPF/CNPJ (só dígitos), quando o meio de pagamento exige
  discountPct?: number; // desconto dado pela IA, dentro do limite da Central do Robô
};

export type BotProduct = {
  id: number;
  sku: string;
  name: string;
  unitLabel: string;
  weightGrams: number;
  priceCents: number;
  availableUnits: number;
};

export type CepQuote =
  | { ok: true; region: string; feeCents: number; freeShippingOverCents: number | null; nextDelivery: string | null; nextDeliveryLabel: string | null }
  | { ok: false; message: string };

export type BotOrderSummary = { code: string; status: string; totalCents: number; scheduledDelivery: string | null; createdAt: string };

export type BotDeps = {
  categories(): Promise<{ slug: string; name: string }[]>;
  products(categorySlug: string): Promise<BotProduct[]>;
  productById(id: number): Promise<BotProduct | null>;
  productBySku(sku: string): Promise<BotProduct | null>;
  quoteCep(cep: string): Promise<CepQuote>;
  placeOrder(input: { cart: CartLine[]; cep: string; address: Required<Omit<BotAddress, "complement">> & { complement?: string }; discountCents?: number }): Promise<
    { ok: true; code: string; totalCents: number; shippingCents: number; scheduledDelivery: string | null } | { ok: false; message: string }
  >;
  recentOrders(): Promise<BotOrderSummary[]>;
  hours: string;
  // Pagamento: o provedor ativo exige CPF/CNPJ? E a última cobrança do cliente (para "já paguei").
  needsDocument?: boolean;
  lastPayment?(): Promise<PaymentInfo | null>;
  // Configuração da Central do Robô (saudação, perguntas frequentes, regras). Sem ela, valem os padrões.
  config?: BotConfig;
};

export type PaymentInfo = {
  orderCode: string;
  status: "pending" | "paid" | "expired" | "cancelled" | "failed";
  automatic: boolean;        // provedor confirma sozinho ou a equipe confere
  messages: BotMessage[];    // instruções + código Pix (quando ainda está em aberto)
};

export type Handoff = { topic: "compra" | "atacado" | "pedido" | "duvida" | "reclamacao"; reason: string };

export type BotResult = {
  messages: BotMessage[];
  state: string;
  data: BotData;
  handoff?: Handoff;
  orderCode?: string;
  customerName?: string;
  unanswered?: string; // pergunta que o robô não soube responder (vai para a Central do Robô)
};

export type BotInput = { state: string; data: BotData; text: string; contactName: string | null };

// ---------- formatação ----------

const brlFmt = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });
export const brl = (cents: number) => brlFmt.format(cents / 100).replace(/ /g, " ");

export const ORDER_STATUS_LABEL: Record<string, string> = {
  pending: "Recebido — aguardando confirmação do pagamento",
  confirmed: "Pagamento confirmado",
  preparing: "Em separação na câmara fria",
  in_transit: "Saiu para entrega (rota refrigerada)",
  delivered: "Entregue",
  cancelled: "Cancelado",
};

const dateBr = (iso: string) => {
  const [, m, d] = iso.slice(0, 10).split("-");
  return `${d}/${m}`;
};

function numbered(options: BotOption[]): string {
  return options.map((o) => `*${o.key}* · ${o.label}`).join("\n");
}

function ask(body: string, options?: BotOption[]): BotMessage {
  return options?.length ? { body: `${body}\n\n${numbered(options)}`, options } : { body };
}

export const cartTotal = (cart: CartLine[]) => cart.reduce((a, l) => a + l.priceCents * l.quantity, 0);

export function cartText(cart: CartLine[]): string {
  const lines = cart.map((l) => `• ${l.quantity}× ${l.name} — ${brl(l.priceCents * l.quantity)}`);
  return `${lines.join("\n")}\n*Subtotal: ${brl(cartTotal(cart))}*`;
}

// ---------- entrada do cliente ----------

const GLOBAL = {
  menu: ["menu", "inicio", "comecar", "voltar ao menu", "oi", "ola", "bom dia", "boa tarde", "boa noite"],
  human: ["atendente", "humano", "pessoa", "falar com alguem", "falar com atendente", "responsavel"],
  cart: ["carrinho", "ver carrinho", "meu carrinho"],
  cancel: ["cancelar", "sair", "parar"],
  complaint: ["reclamacao", "reclamar", "problema com", "veio errado", "estragado", "chegou quente", "atrasado"],
};

const matchesAny = (text: string, words: string[]) => words.some((w) => text === w || text.startsWith(`${w} `) || text.endsWith(` ${w}`));

// Escolhe uma opção pelo número ("2", "2️⃣", "opção 2") ou por uma palavra do rótulo ("finalizar").
export function pickOption(text: string, options: BotOption[]): BotOption | undefined {
  const t = normalize(text);
  const digits = t.match(/^\D{0,10}?(\d{1,2})\D{0,3}$/);
  if (digits) return options.find((o) => o.key === String(Number(digits[1])));
  if (t.length < 3) return undefined;
  return options.find((o) => {
    const label = normalize(o.label);
    return label === t || label.startsWith(t) || (t.length >= 5 && label.includes(t));
  });
}

export function parseQuantity(text: string): number | undefined {
  const t = normalize(text);
  const words: Record<string, number> = { um: 1, uma: 1, dois: 2, duas: 2, tres: 3, quatro: 4, cinco: 5, seis: 6, sete: 7, oito: 8, nove: 9, dez: 10, meia: 6, "meia duzia": 6, duzia: 12, "uma duzia": 12 };
  if (words[t] !== undefined) return words[t];
  const m = t.match(/^(\d{1,4})\b/);
  return m ? Number(m[1]) : undefined;
}

// "Cidade/UF", "Cidade - UF" ou "Cidade UF".
export function parseCityState(text: string): { city: string; state: string } | undefined {
  const m = text.trim().match(/^(.{2,60}?)\s*(?:[/\-,]\s*|\s+)([A-Za-z]{2})$/);
  if (!m) return undefined;
  return { city: m[1]!.trim(), state: m[2]!.toUpperCase() };
}

// Mensagem pronta que o site manda ("... (cód. CAN-MC600)").
export function skuFromSiteMessage(text: string): string | undefined {
  return text.match(/c[oó]d(?:igo)?\.?\s*:?\s*([A-Z0-9][A-Z0-9-]{2,})/i)?.[1]?.toUpperCase();
}

// Carrinho do site ("Finalizar pelo WhatsApp"): uma linha por item, com quantidade e código.
//   Olá! Quero finalizar meu pedido do site:
//   • 2× Queijo Canastra Meia-Cura (cód. CAN-MC600)
//   • 1 cx Doce de Leite Cremoso (cód. DDL-CR400)
//   CEP: 30130-000
export type SiteCartLine = { sku: string; quantity: number; box: boolean };
export type SiteCart = { lines: SiteCartLine[]; cep?: string };

export function siteCartFromMessage(text: string): SiteCart | undefined {
  if (!/finalizar\s+(?:o\s+|meu\s+)?pedido/i.test(text)) return undefined;
  const lines: SiteCartLine[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*[•*\-]?\s*(\d{1,4})\s*(cx\b|caixas?\b|un\b|[x×])?\s*.+?\(c[oó]d(?:igo)?\.?\s*:?\s*([A-Z0-9][A-Z0-9-]{2,})\)/i);
    if (!m) continue;
    const quantity = Number(m[1]);
    if (quantity < 1) continue;
    lines.push({ sku: m[3]!.toUpperCase(), quantity, box: /^c/i.test(m[2] ?? "") });
  }
  if (lines.length === 0) return undefined;
  const cep = text.match(/\bCEP\b\s*:?\s*(\d{5})-?(\d{3})\b/i);
  return { lines, cep: cep ? `${cep[1]}${cep[2]}` : undefined };
}

// ---------- menus ----------

const MENU: BotOption[] = [
  { key: "1", label: "Ver produtos e fazer um pedido" },
  { key: "2", label: "Acompanhar meu pedido" },
  { key: "3", label: "Compra para empresa (atacado)" },
  { key: "4", label: "Entrega na minha região" },
  { key: "5", label: "Falar com um atendente" },
];

const CART_ACTIONS: BotOption[] = [
  { key: "1", label: "Adicionar mais produtos" },
  { key: "2", label: "Finalizar pedido" },
  { key: "3", label: "Remover um item" },
  { key: "4", label: "Esvaziar carrinho" },
];

const CONFIRM_ACTIONS: BotOption[] = [
  { key: "1", label: "Confirmar pedido" },
  { key: "2", label: "Corrigir endereço" },
  { key: "3", label: "Voltar ao carrinho" },
  { key: "4", label: "Cancelar" },
];

function firstName(name: string | null | undefined) {
  return name?.trim().split(/\s+/)[0] ?? "";
}

function menu(data: BotData, intro?: string): BotResult {
  return { messages: [ask(intro ?? "Como posso ajudar?", MENU)], state: "menu", data: { ...data, list: undefined, fails: 0 } };
}

function handoff(data: BotData, topic: Handoff["topic"], reason: string, hours: string, extra?: string): BotResult {
  return {
    messages: [
      {
        body:
          `${extra ? `${extra}\n\n` : ""}Já chamei um responsável da Encantos para continuar com você por aqui. 🧀\n` +
          `Atendimento humano: ${hours}.\n\nSe quiser voltar ao atendimento automático, digite *menu*.`,
      },
    ],
    state: "human",
    data: { ...data, list: undefined, fails: 0 },
    handoff: { topic, reason },
  };
}

async function showCategories(deps: BotDeps, data: BotData, intro = "Qual linha você quer ver?"): Promise<BotResult> {
  const cats = await deps.categories();
  const list = cats.map((c) => ({ id: c.slug, label: c.name }));
  const options = [...list.map((c, i) => ({ key: String(i + 1), label: c.label })), { key: "0", label: "Voltar ao menu" }];
  return { messages: [ask(intro, options)], state: "categories", data: { ...data, list, fails: 0 } };
}

async function showProducts(deps: BotDeps, data: BotData, slug: string): Promise<BotResult> {
  const products = await deps.products(slug);
  if (products.length === 0) return showCategories(deps, data, "Essa linha está sem produtos no momento. Escolha outra:");
  const list = products.map((p) => ({ id: p.id, label: p.name }));
  const lines = products.map((p, i) => {
    const stock = p.availableUnits > 0 ? "" : " _(esgotado)_";
    return `*${i + 1}* · ${p.name} — ${brl(p.priceCents)} / ${p.unitLabel} ${p.weightGrams} g${stock}`;
  });
  const options: BotOption[] = [...products.map((p, i) => ({ key: String(i + 1), label: p.name })), { key: "0", label: "Voltar às linhas" }];
  return {
    messages: [{ body: `Digite o número do produto:\n\n${lines.join("\n")}\n*0* · Voltar às linhas`, options }],
    state: "products",
    data: { ...data, categorySlug: slug, list, fails: 0 },
  };
}

function askQuantity(p: BotProduct, data: BotData): BotResult {
  return {
    messages: [{ body: `*${p.name}* — ${brl(p.priceCents)} por ${p.unitLabel} (${p.weightGrams} g).${p.availableUnits <= 20 ? `\n⚠️ Restam só ${p.availableUnits}.` : ""}\n\nQuantas unidades você quer? (digite só o número)` }],
    state: "quantity",
    data: { ...data, pendingProductId: p.id, fails: 0 },
  };
}

function showCart(data: BotData, intro?: string): BotResult {
  const cart = data.cart ?? [];
  if (cart.length === 0) {
    return { messages: [ask(`${intro ? `${intro}\n\n` : ""}Seu carrinho está vazio.`, [{ key: "1", label: "Ver produtos" }, { key: "0", label: "Voltar ao menu" }])], state: "empty_cart", data: { ...data, fails: 0 } };
  }
  return {
    messages: [ask(`${intro ? `${intro}\n\n` : ""}🛒 *Seu carrinho*\n${cartText(cart)}`, CART_ACTIONS)],
    state: "cart",
    data: { ...data, list: undefined, fails: 0 },
  };
}

function addressLine(a: BotAddress) {
  return `${a.street}, ${a.number}${a.complement ? ` (${a.complement})` : ""} — ${a.district}, ${a.city}/${a.state}`;
}

function confirmation(data: BotData): BotResult {
  const cart = data.cart ?? [];
  const sub = cartTotal(cart);
  const s = data.shipping!;
  const fee = s.freeShippingOverCents !== null && sub >= s.freeShippingOverCents ? 0 : s.feeCents;
  const a = data.address!;
  const body =
    `📋 *Confira seu pedido*\n\n${cartText(cart)}\n` +
    `Frete refrigerado: ${fee === 0 ? "grátis" : brl(fee)}\n*Total: ${brl(sub + fee)}*\n\n` +
    `📍 Entrega para *${a.recipient}*\n${addressLine(a)}\nCEP ${data.cep}\n` +
    (s.nextDelivery ? `🚚 Previsão: ${s.nextDelivery}\n` : "") +
    `\nDepois de confirmar, você recebe aqui mesmo os dados para pagamento.`;
  return { messages: [ask(body, CONFIRM_ACTIONS)], state: "confirm", data: { ...data, fails: 0 } };
}

function nextAddressStep(data: BotData, contactName: string | null): BotResult {
  const a = data.address ?? {};
  if (!a.recipient) {
    if (contactName) return nextAddressStep({ ...data, address: { ...a, recipient: contactName } }, contactName);
    return { messages: [{ body: "Para quem é a entrega? (nome de quem vai receber)" }], state: "addr_recipient", data };
  }
  if (!a.street || !a.number) return { messages: [{ body: "Qual a *rua e o número*? Ex.: _Rua das Flores, 120_" }], state: "addr_street", data };
  if (!a.district) return { messages: [{ body: "Qual o *bairro*?" }], state: "addr_district", data };
  if (!a.city || !a.state) return { messages: [{ body: "Qual a *cidade e o estado*? Ex.: _Belo Horizonte/MG_" }], state: "addr_city", data };
  if (a.complement === undefined) return { messages: [{ body: "Tem *complemento*? (apto, bloco, loja…) Se não tiver, digite *não*." }], state: "addr_complement", data };
  return confirmation(data);
}

const greeting = (contactName: string | null, deps: BotDeps) =>
  renderGreeting((deps.config ?? DEFAULT_BOT_CONFIG).persona.greeting, firstName(contactName));

// Pedido mínimo da Central do Robô: devolve o aviso quando o carrinho ainda não chegou lá.
function belowMinimum(cart: CartLine[], deps: BotDeps): string | null {
  const min = deps.config?.rules.minOrderCents ?? 0;
  const sub = cartTotal(cart);
  return min > 0 && sub < min ? `O pedido mínimo é de ${brl(min)}. Faltam ${brl(min - sub)} — quer acrescentar algo?` : null;
}

function cepInfo(cepFmt: string, q: Extract<CepQuote, { ok: true }>) {
  const freeText = q.freeShippingOverCents !== null ? ` (grátis acima de ${brl(q.freeShippingOverCents)})` : "";
  return `📍 CEP ${cepFmt} — região *${q.region}*\nFrete refrigerado: ${q.feeCents === 0 ? "grátis" : brl(q.feeCents)}${freeText}\n` +
    (q.nextDeliveryLabel ? `🚚 Próxima rota: ${q.nextDeliveryLabel}` : "");
}

const withShipping = (data: BotData, cepFmt: string, q: Extract<CepQuote, { ok: true }>): BotData =>
  ({ ...data, cep: cepFmt, shipping: { feeCents: q.feeCents, freeShippingOverCents: q.freeShippingOverCents, region: q.region, nextDelivery: q.nextDeliveryLabel } });

// O cliente montou o carrinho no site e tocou em "Finalizar pelo WhatsApp".
// O carrinho do site substitui o da conversa; preço e estoque vêm sempre do sistema, nunca da mensagem.
async function receiveSiteCart(input: BotInput, deps: BotDeps, site: SiteCart): Promise<BotResult> {
  const greet = input.state === "start" || input.state === "human" ? [{ body: greeting(input.contactName, deps) }] : [];
  const data: BotData = { ...input.data, list: undefined, pendingProductId: undefined, fails: 0 };

  if (site.lines.some((l) => l.box)) {
    const reason = `Carrinho de atacado do site: ${site.lines.map((l) => `${l.quantity} ${l.box ? "cx" : "un"} ${l.sku}`).join(", ")}`;
    const h = handoff(data, "atacado", reason, deps.hours, "Recebi seu carrinho com compra por caixa (atacado). Um responsável confirma preço por faixa e entrega com você.");
    return { ...h, messages: [...greet, ...h.messages] };
  }

  const cart: CartLine[] = [];
  const notes: string[] = [];
  for (const l of site.lines) {
    const p = await deps.productBySku(l.sku);
    if (!p) { notes.push(`• Não encontrei o produto de código ${l.sku}.`); continue; }
    const already = cart.find((c) => c.productId === p.id);
    const wanted = l.quantity + (already?.quantity ?? 0);
    if (p.availableUnits <= 0) { notes.push(`• *${p.name}* esgotou e ficou de fora.`); continue; }
    const qty = Math.min(wanted, p.availableUnits);
    if (qty < wanted) notes.push(`• *${p.name}*: temos só ${qty}, ajustei a quantidade.`);
    if (already) already.quantity = qty;
    else cart.push({ productId: p.id, sku: p.sku, name: p.name, unitLabel: p.unitLabel, priceCents: p.priceCents, quantity: qty });
  }
  const warn = notes.length ? `\n\n⚠️ ${notes.length === 1 ? "Um ajuste" : "Alguns ajustes"}:\n${notes.join("\n")}` : "";

  if (cart.length === 0) {
    const cats = await showCategories(deps, { ...data, cart: [] }, `Recebi seu carrinho do site, mas nenhum item está disponível agora 😕${warn}\n\nQuer ver outras opções?`);
    return { ...cats, messages: [...greet, ...cats.messages] };
  }

  const big = cart.find((l) => l.quantity > 50);
  if (big) {
    const h = handoff({ ...data, cart }, "atacado", `Carrinho do site com ${big.quantity} un de ${big.name} — volume de atacado`, deps.hours, `Para ${big.quantity} unidades temos condição especial por caixa.`);
    return { ...h, messages: [...greet, ...h.messages] };
  }

  const summary = { body: `🛒 *Recebi seu carrinho do site*\n${cartText(cart)}${warn}\n\n_Para mudar algo, digite *carrinho*._` };
  const withCart: BotData = { ...data, cart };
  const min = belowMinimum(cart, deps);
  if (min) {
    const c = showCart(withCart, `🛒 *Recebi seu carrinho do site*${warn}\n\n${min}`);
    return { ...c, messages: [...greet, ...c.messages] };
  }

  if (site.cep) {
    const q = await deps.quoteCep(site.cep);
    if (q.ok) {
      const cepFmt = `${site.cep.slice(0, 5)}-${site.cep.slice(5)}`;
      const next = nextAddressStep(withShipping(withCart, cepFmt, q), input.contactName);
      return { ...next, messages: [...greet, summary, { body: cepInfo(cepFmt, q) }, ...next.messages] };
    }
    const options = [{ key: "1", label: "Tentar outro CEP" }, { key: "2", label: "Falar com um atendente" }, { key: "0", label: "Voltar ao menu" }];
    return { messages: [...greet, summary, ask(`${q.message} 😕`, options)], state: "out_of_area", data: { ...withCart, returnTo: "checkout_cep" } };
  }

  return {
    messages: [...greet, summary, { body: "Para calcular o frete refrigerado, qual o *CEP* de entrega? (só os números)" }],
    state: "checkout_cep",
    data: withCart,
  };
}

function notUnderstood(input: BotInput, again: BotResult, deps: BotDeps): BotResult {
  // Frase com cara de pergunta que o robô não entendeu: vira sugestão de conhecimento na Central do Robô.
  const words = input.text.trim().split(/\s+/).length;
  const unanswered = words >= 4 || input.text.includes("?") ? input.text.trim().slice(0, 300) : undefined;
  return { ...notUnderstoodReply(input, again, deps), unanswered };
}

function notUnderstoodReply(input: BotInput, again: BotResult, deps: BotDeps): BotResult {
  const fails = (input.data.fails ?? 0) + 1;
  if (fails >= 3) {
    return handoff(input.data, "duvida", "O bot não entendeu o cliente 3 vezes seguidas", deps.hours, "Desculpe, não consegui entender.");
  }
  const [first, ...rest] = again.messages;
  const hint = fails === 2 ? "\n_Se preferir, digite *atendente* para falar com uma pessoa._" : "";
  return {
    ...again,
    messages: [{ ...first!, body: `Não entendi 🤔 Responda com o *número* da opção.${hint}\n\n${first!.body}` }, ...rest],
    data: { ...again.data, fails },
  };
}

// ---------- pagamento ----------

const PAID_WORDS = ["paguei", "ja paguei", "ja fiz o pix", "fiz o pix", "pix feito", "comprovante", "pagamento", "ja esta pago", "pago"];

const askDocument = (data: BotData, again = false): BotResult => ({
  messages: [{ body: again
    ? "Esse CPF não parece válido 🤔 Confere e me manda de novo, só os números. (Para empresa, pode mandar o CNPJ.)"
    : "Para gerar o pagamento, preciso do seu *CPF* (só os números). Se for empresa, pode mandar o CNPJ." }],
  state: "addr_document",
  data,
});

// "Já paguei" / "cadê o Pix?": responde com a situação real da última cobrança do cliente.
async function paymentReply(data: BotData, state: string, deps: BotDeps): Promise<BotResult | null> {
  const p = await deps.lastPayment?.();
  if (!p) return null;
  if (p.status === "paid") return menu(data, `✅ O pagamento do pedido *${p.orderCode}* já está confirmado. Posso ajudar em algo mais?`);
  if (p.status === "pending" && p.automatic) {
    return {
      messages: [{ body: `Ainda não recebi a confirmação do pagamento do pedido *${p.orderCode}*. Ela é automática e costuma levar poucos minutos depois do Pix. Se precisar, o código está aqui de novo:` }, ...p.messages.slice(1)],
      state, data,
    };
  }
  if (p.status === "pending") {
    return handoff(data, "pedido", `Cliente informou o pagamento do pedido ${p.orderCode}: conferir e confirmar em Pedidos`, deps.hours, "Obrigado! 🙏 Vou pedir para a equipe conferir o pagamento e já te confirmo por aqui.");
  }
  return menu(data, `O prazo de pagamento do pedido *${p.orderCode}* terminou e ele foi cancelado. Se quiser, fazemos um novo pedido agora. 🙂`);
}

// ---------- fluxo principal ----------

const EMOJI = /\p{Extended_Pictographic}️?\s?/gu;

export async function runBot(input: BotInput, deps: BotDeps): Promise<BotResult> {
  let result = await runBotFlow(input, deps);
  // O meio de pagamento exige CPF: pergunta antes do resumo final.
  if (result.state === "confirm" && deps.needsDocument && !result.data.document) {
    const ask = askDocument(result.data);
    result = { ...result, messages: [...result.messages.slice(0, -1), ...ask.messages], state: ask.state };
  }
  // Central do Robô: sem emojis, se os donos preferirem.
  if (deps.config && !deps.config.persona.emojis) {
    result = { ...result, messages: result.messages.map((m) => ({ ...m, body: m.body.replace(EMOJI, "").replace(/ +\n/g, "\n").trim() })) };
  }
  return result;
}

async function runBotFlow(input: BotInput, deps: BotDeps): Promise<BotResult> {
  const raw = input.text.trim();
  const t = normalize(raw);
  const data: BotData = { ...input.data };
  const state = input.state;

  // Carrinho vindo do site: vale em qualquer etapa (o cliente pode voltar ao site no meio da conversa).
  const site = siteCartFromMessage(raw);
  if (site) return receiveSiteCart(input, deps, site);

  const cfg = deps.config ?? DEFAULT_BOT_CONFIG;

  // Comandos que valem em qualquer etapa.
  if (state !== "start" && matchesAny(t, GLOBAL.human)) return handoff(data, "duvida", "Cliente pediu para falar com um atendente", deps.hours);
  if (containsKeyword(raw, cfg.rules.handoffKeywords)) {
    const h = handoff(data, "duvida", `Palavra que chama a equipe (Central do Robô): "${raw.slice(0, 120)}"`, deps.hours);
    return state === "start" ? { ...h, messages: [{ body: greeting(input.contactName, deps) }, ...h.messages] } : h;
  }
  if (GLOBAL.complaint.some((w) => t.includes(w)) && state !== "wholesale_details") {
    return handoff(data, "reclamacao", `Possível reclamação: "${raw.slice(0, 120)}"`, deps.hours, "Sinto muito pelo ocorrido. 🙏");
  }
  if (state !== "start" && GLOBAL.menu.includes(t)) return menu(data, "Voltamos ao início. Como posso ajudar?");
  if (matchesAny(t, GLOBAL.cart) && state !== "start") return showCart(data);
  if (state !== "confirm" && state !== "addr_document" && PAID_WORDS.some((w) => t === w || t.startsWith(`${w} `) || t.includes(` ${w}`))) {
    const reply = await paymentReply(data, state === "start" ? "menu" : state, deps);
    if (reply) return reply;
  }
  // Perguntas frequentes da Central do Robô (no começo da conversa e no menu).
  if ((state === "start" || state === "menu") && cfg.faqs.length) {
    const faq = matchFaq(raw, cfg.faqs);
    if (faq) {
      const m = menu(data, `${faq.answer}\n\nPosso ajudar em algo mais?`);
      return state === "start" ? { ...m, messages: [{ body: greeting(input.contactName, deps) }, ...m.messages] } : m;
    }
  }
  if (GLOBAL.cancel.includes(t) && state !== "start") return menu({ ...data, cart: [], address: undefined }, "Tudo bem, cancelei o que estava em andamento. Como posso ajudar?");

  switch (state) {
    case "start":
    case "human": {
      const hello = greeting(input.contactName, deps);
      // Veio do botão "Pedir pelo WhatsApp" do site: já abre o produto.
      const sku = skuFromSiteMessage(raw);
      if (sku) {
        const p = await deps.productBySku(sku);
        if (p && p.availableUnits > 0) {
          // "Quero pedir 2 peças de ..." (página do produto): já entra no carrinho com a quantidade.
          const qty = Number(raw.match(/pedir\s+(\d{1,3})\s/i)?.[1] ?? 0);
          if (qty >= 1 && qty <= p.availableUnits && qty <= 50) {
            const cart = [...(data.cart ?? []).filter((l) => l.productId !== p.id), { productId: p.id, sku: p.sku, name: p.name, unitLabel: p.unitLabel, priceCents: p.priceCents, quantity: qty }];
            const c = showCart({ ...data, cart }, `✅ Separei ${qty}× ${p.name} (${brl(p.priceCents)} cada).`);
            return { ...c, messages: [{ body: hello }, ...c.messages] };
          }
          const q = askQuantity(p, data);
          return { ...q, messages: [{ body: hello }, ...q.messages] };
        }
        if (p) {
          const cats = await showCategories(deps, data, `O *${p.name}* acabou de esgotar 😕 Quer ver outras opções?`);
          return { ...cats, messages: [{ body: hello }, ...cats.messages] };
        }
      }
      if (t.includes("compra para empresa") || t.includes("atacado")) {
        const h = handoff(data, "atacado", "Interesse em compra para empresa (veio do site)", deps.hours, "Recebi seu interesse em compra para empresa.");
        return { ...h, messages: [{ body: hello }, ...h.messages] };
      }
      if (matchesAny(t, GLOBAL.human)) return handoff(data, "duvida", "Cliente pediu para falar com um atendente", deps.hours, hello);
      const m = menu(data);
      return { ...m, messages: [{ body: hello }, ...m.messages] };
    }

    case "menu": {
      const opt = pickOption(raw, MENU) ?? (t.includes("pedido") && t.includes("acompanh") ? MENU[1] : t.includes("produto") || t.includes("comprar") || t.includes("preco") ? MENU[0] : undefined);
      switch (opt?.key) {
        case "1": return showCategories(deps, data);
        case "2": {
          const orders = await deps.recentOrders();
          if (orders.length === 0) return menu(data, "Não encontrei pedidos feitos por este número. Se você comprou pelo site com outro telefone, digite *atendente*.");
          const lines = orders.map((o) =>
            `*${o.code}* · ${dateBr(o.createdAt)} · ${brl(o.totalCents)}\n   ${ORDER_STATUS_LABEL[o.status] ?? o.status}${o.scheduledDelivery && !["delivered", "cancelled"].includes(o.status) ? ` · entrega prevista ${dateBr(o.scheduledDelivery)}` : ""}`);
          return menu(data, `📦 *Seus pedidos recentes*\n\n${lines.join("\n\n")}\n\nPosso ajudar em algo mais?`);
        }
        case "3":
          return {
            messages: [{ body: "Que bom! Atendemos empórios, restaurantes e redes com preço por caixa. 🧀\n\nMe conte em *uma mensagem*: quais produtos, quantidade aproximada, cidade e com que frequência pretende comprar." }],
            state: "wholesale_details",
            data: { ...data, fails: 0 },
          };
        case "4":
          return { messages: [{ body: "Me informe o *CEP* de entrega (só os números) que eu vejo a região, o frete e o próximo dia de rota." }], state: "delivery_cep", data: { ...data, returnTo: "menu" } };
        case "5":
          return handoff(data, "duvida", "Cliente escolheu falar com um atendente no menu", deps.hours);
        default:
          return notUnderstood(input, menu(data), deps);
      }
    }

    case "categories": {
      const list = data.list ?? [];
      const options = [...list.map((c, i) => ({ key: String(i + 1), label: c.label })), { key: "0", label: "Voltar ao menu" }];
      const opt = pickOption(raw, options);
      if (opt?.key === "0") return menu(data);
      const chosen = opt ? list[Number(opt.key) - 1] : undefined;
      if (!chosen) return notUnderstood(input, await showCategories(deps, data), deps);
      return showProducts(deps, data, String(chosen.id));
    }

    case "products": {
      const list = data.list ?? [];
      const options = [...list.map((p, i) => ({ key: String(i + 1), label: p.label })), { key: "0", label: "Voltar" }];
      const opt = pickOption(raw, options);
      if (opt?.key === "0") return showCategories(deps, data);
      const chosen = opt ? list[Number(opt.key) - 1] : undefined;
      if (!chosen) return notUnderstood(input, await showProducts(deps, data, data.categorySlug!), deps);
      const p = await deps.productById(Number(chosen.id));
      if (!p || p.availableUnits <= 0) {
        const again = await showProducts(deps, data, data.categorySlug!);
        return { ...again, messages: [{ body: `O *${chosen.label}* está esgotado no momento. Escolha outro, por favor.` }, ...again.messages] };
      }
      return askQuantity(p, data);
    }

    case "quantity": {
      const p = data.pendingProductId ? await deps.productById(data.pendingProductId) : null;
      if (!p) return showCategories(deps, data);
      const qty = parseQuantity(raw);
      if (!qty || qty < 1) return notUnderstood(input, askQuantity(p, data), deps);
      const inCart = data.cart?.find((l) => l.productId === p.id)?.quantity ?? 0;
      if (qty + inCart > p.availableUnits) {
        const left = p.availableUnits - inCart;
        return {
          messages: [{ body: left > 0
            ? `Temos só *${left}* disponíveis de ${p.name}${inCart ? ` além das ${inCart} que já estão no carrinho` : ""}. Quantas você quer?`
            : `Você já tem todas as unidades disponíveis de ${p.name} no carrinho.` }],
          state: left > 0 ? "quantity" : "cart",
          data,
        };
      }
      if (qty > 50) {
        return handoff(data, "atacado", `Cliente quer ${qty} un de ${p.name} — volume de atacado`, deps.hours, `Para ${qty} unidades temos condição especial por caixa.`);
      }
      const cart = [...(data.cart ?? [])];
      const idx = cart.findIndex((l) => l.productId === p.id);
      if (idx >= 0) cart[idx] = { ...cart[idx]!, quantity: cart[idx]!.quantity + qty, priceCents: p.priceCents };
      else cart.push({ productId: p.id, sku: p.sku, name: p.name, unitLabel: p.unitLabel, priceCents: p.priceCents, quantity: qty });
      return showCart({ ...data, cart, pendingProductId: undefined }, `✅ Adicionei ${qty}× ${p.name}.`);
    }

    case "empty_cart": {
      const opt = pickOption(raw, [{ key: "1", label: "Ver produtos" }, { key: "0", label: "Voltar ao menu" }]);
      if (opt?.key === "1") return showCategories(deps, data);
      return menu(data);
    }

    case "cart": {
      const opt = pickOption(raw, CART_ACTIONS);
      switch (opt?.key) {
        case "1": return showCategories(deps, data);
        case "2": {
          if (!data.cart?.length) return showCart(data);
          const min = belowMinimum(data.cart, deps);
          if (min) return showCart(data, min);
          if (data.cep && data.shipping) return nextAddressStep(data, input.contactName);
          return { messages: [{ body: "Para calcular o frete refrigerado, qual o *CEP* de entrega? (só os números)" }], state: "checkout_cep", data: { ...data, fails: 0 } };
        }
        case "3": {
          const list = (data.cart ?? []).map((l) => ({ id: l.productId, label: `${l.quantity}× ${l.name}` }));
          const options = [...list.map((l, i) => ({ key: String(i + 1), label: l.label })), { key: "0", label: "Voltar ao carrinho" }];
          return { messages: [ask("Qual item você quer remover?", options)], state: "remove_item", data: { ...data, list } };
        }
        case "4": return showCart({ ...data, cart: [] }, "Carrinho esvaziado.");
        default: return notUnderstood(input, showCart(data), deps);
      }
    }

    case "remove_item": {
      const list = data.list ?? [];
      const options = [...list.map((l, i) => ({ key: String(i + 1), label: l.label })), { key: "0", label: "Voltar" }];
      const opt = pickOption(raw, options);
      if (opt?.key === "0") return showCart(data);
      const chosen = opt ? list[Number(opt.key) - 1] : undefined;
      if (!chosen) return notUnderstood(input, { messages: [ask("Qual item você quer remover?", options)], state, data }, deps);
      return showCart({ ...data, cart: (data.cart ?? []).filter((l) => l.productId !== chosen.id), list: undefined }, "Item removido.");
    }

    case "checkout_cep":
    case "delivery_cep": {
      const cep = onlyDigits(raw);
      if (cep.length !== 8) {
        return notUnderstood(input, { messages: [{ body: "O CEP precisa ter 8 números. Ex.: *30130000*" }], state, data }, deps);
      }
      const q = await deps.quoteCep(cep);
      const cepFmt = `${cep.slice(0, 5)}-${cep.slice(5)}`;
      if (!q.ok) {
        const options = [{ key: "1", label: "Tentar outro CEP" }, { key: "2", label: "Falar com um atendente" }, { key: "0", label: "Voltar ao menu" }];
        return { messages: [ask(`${q.message} 😕`, options)], state: "out_of_area", data: { ...data, returnTo: state } };
      }
      const info = cepInfo(cepFmt, q);
      if (state === "delivery_cep") return menu(data, `${info}\n\nPosso ajudar em algo mais?`);
      const next = nextAddressStep(withShipping(data, cepFmt, q), input.contactName);
      return { ...next, messages: [{ body: info }, ...next.messages] };
    }

    case "out_of_area": {
      const opt = pickOption(raw, [{ key: "1", label: "Tentar outro CEP" }, { key: "2", label: "Falar com um atendente" }, { key: "0", label: "Voltar ao menu" }]);
      if (opt?.key === "1") return { messages: [{ body: "Qual o CEP? (só os números)" }], state: data.returnTo === "delivery_cep" ? "delivery_cep" : "checkout_cep", data };
      if (opt?.key === "2") return handoff(data, "compra", "CEP fora da área de entrega", deps.hours);
      return menu(data);
    }

    case "addr_recipient":
      if (raw.length < 3) return notUnderstood(input, nextAddressStep(data, null), deps);
      return { ...nextAddressStep({ ...data, address: { ...data.address, recipient: raw.slice(0, 80) } }, null), customerName: input.contactName ? undefined : raw.slice(0, 80) };

    case "addr_street": {
      const m = raw.match(/^(.{3,}?)[,\s]+(n[ºo°.]*\s*)?(\d+[A-Za-z]?|s\/?n)\b(.*)$/i);
      if (!m) return { messages: [{ body: "Preciso da rua *e* do número juntos. Ex.: _Rua das Flores, 120_" }], state, data };
      const extra = m[4]?.replace(/^[\s,\-]+/, "").trim();
      return nextAddressStep({ ...data, address: { ...data.address, street: m[1]!.trim(), number: m[3]!.toUpperCase(), ...(extra ? { complement: extra } : {}) } }, input.contactName);
    }

    case "addr_district":
      if (raw.length < 2) return notUnderstood(input, nextAddressStep(data, input.contactName), deps);
      return nextAddressStep({ ...data, address: { ...data.address, district: raw.slice(0, 80) } }, input.contactName);

    case "addr_city": {
      const cs = parseCityState(raw);
      if (!cs) return { messages: [{ body: "Escreva a cidade e a sigla do estado. Ex.: _Belo Horizonte/MG_" }], state, data };
      return nextAddressStep({ ...data, address: { ...data.address, ...cs } }, input.contactName);
    }

    case "addr_complement": {
      const none = ["nao", "n", "nenhum", "sem", "nao tem", "-"].includes(t);
      return nextAddressStep({ ...data, address: { ...data.address, complement: none ? "" : raw.slice(0, 80) } }, input.contactName);
    }

    case "addr_document": {
      const doc = onlyDigits(raw);
      if (!isValidCpf(doc) && !isValidCnpj(doc)) {
        const fails = (data.fails ?? 0) + 1;
        if (fails >= 3) return handoff(data, "compra", "Cliente não conseguiu informar um CPF válido para o pagamento", deps.hours);
        return { ...askDocument(data, true), data: { ...data, fails } };
      }
      return confirmation({ ...data, document: doc, fails: 0 });
    }

    case "confirm": {
      const opt = pickOption(raw, CONFIRM_ACTIONS) ?? (["sim", "s", "ok", "confirmo", "pode"].includes(t) ? CONFIRM_ACTIONS[0] : undefined);
      switch (opt?.key) {
        case "1": {
          const a = data.address!;
          const result = await deps.placeOrder({
            cart: data.cart ?? [],
            cep: data.cep!,
            address: { recipient: a.recipient!, street: a.street!, number: a.number!, district: a.district!, city: a.city!, state: a.state!, complement: a.complement || undefined },
          });
          if (!result.ok) {
            return showCart(data, `⚠️ ${result.message}. Ajuste o carrinho e tente de novo.`);
          }
          const clean: BotData = { address: data.address, cep: data.cep, shipping: data.shipping, document: data.document };
          return {
            messages: [{
              body: `🎉 *Pedido ${result.code} recebido!*\nTotal: ${brl(result.totalCents)}` +
                (result.scheduledDelivery ? `\nEntrega prevista: ${dateBr(result.scheduledDelivery)}` : "") +
                `\n\nJá te mando os dados para pagamento. 👇 Você recebe cada atualização do pedido neste número.`,
            }],
            state: "menu",
            data: clean,
            orderCode: result.code,
          };
        }
        case "2": return nextAddressStep({ ...data, address: { recipient: data.address?.recipient } }, null);
        case "3": return showCart(data);
        case "4": return menu({ ...data, cart: [] }, "Pedido cancelado. Como posso ajudar?");
        default: return notUnderstood(input, confirmation(data), deps);
      }
    }

    case "wholesale_details":
      if (raw.length < 4) return notUnderstood(input, { messages: [{ body: "Me conte os produtos, a quantidade e a cidade em uma mensagem." }], state, data }, deps);
      return handoff(data, "atacado", `Atacado: "${raw.slice(0, 200)}"`, deps.hours, "Anotado! ✍️");

    default:
      return menu(data);
  }
}
