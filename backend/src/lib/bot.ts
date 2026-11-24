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
  placeOrder(input: { cart: CartLine[]; cep: string; address: Required<Omit<BotAddress, "complement">> & { complement?: string } }): Promise<
    { ok: true; code: string; totalCents: number; shippingCents: number; scheduledDelivery: string | null } | { ok: false; message: string }
  >;
  recentOrders(): Promise<BotOrderSummary[]>;
  hours: string;
};

export type Handoff = { topic: "compra" | "atacado" | "pedido" | "duvida" | "reclamacao"; reason: string };

export type BotResult = {
  messages: BotMessage[];
  state: string;
  data: BotData;
  handoff?: Handoff;
  orderCode?: string;
  customerName?: string;
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

function cartText(cart: CartLine[]): string {
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
    `\nO pagamento (Pix ou boleto para empresas) é combinado com um responsável depois da confirmação.`;
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

function notUnderstood(input: BotInput, again: BotResult, deps: BotDeps): BotResult {
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

// ---------- fluxo principal ----------

export async function runBot(input: BotInput, deps: BotDeps): Promise<BotResult> {
  const raw = input.text.trim();
  const t = normalize(raw);
  const data: BotData = { ...input.data };
  const state = input.state;

  // Comandos que valem em qualquer etapa.
  if (state !== "start" && matchesAny(t, GLOBAL.human)) return handoff(data, "duvida", "Cliente pediu para falar com um atendente", deps.hours);
  if (GLOBAL.complaint.some((w) => t.includes(w)) && state !== "wholesale_details") {
    return handoff(data, "reclamacao", `Possível reclamação: "${raw.slice(0, 120)}"`, deps.hours, "Sinto muito pelo ocorrido. 🙏");
  }
  if (state !== "start" && GLOBAL.menu.includes(t)) return menu(data, "Voltamos ao início. Como posso ajudar?");
  if (matchesAny(t, GLOBAL.cart) && state !== "start") return showCart(data);
  if (GLOBAL.cancel.includes(t) && state !== "start") return menu({ ...data, cart: [], address: undefined }, "Tudo bem, cancelei o que estava em andamento. Como posso ajudar?");

  switch (state) {
    case "start":
    case "human": {
      const name = firstName(input.contactName);
      const hello = `Olá${name ? `, ${name}` : ""}! 👋 Aqui é o atendimento da *Encantos da Serra* — laticínios artesanais da serra mineira.`;
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
        case "2":
          if (!data.cart?.length) return showCart(data);
          if (data.cep && data.shipping) return nextAddressStep(data, input.contactName);
          return { messages: [{ body: "Para calcular o frete refrigerado, qual o *CEP* de entrega? (só os números)" }], state: "checkout_cep", data: { ...data, fails: 0 } };
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
      const freeText = q.freeShippingOverCents !== null ? ` (grátis acima de ${brl(q.freeShippingOverCents)})` : "";
      const info = `📍 CEP ${cepFmt} — região *${q.region}*\nFrete refrigerado: ${q.feeCents === 0 ? "grátis" : brl(q.feeCents)}${freeText}\n` +
        (q.nextDeliveryLabel ? `🚚 Próxima rota: ${q.nextDeliveryLabel}` : "");
      if (state === "delivery_cep") return menu(data, `${info}\n\nPosso ajudar em algo mais?`);
      const next = nextAddressStep({ ...data, cep: cepFmt, shipping: { feeCents: q.feeCents, freeShippingOverCents: q.freeShippingOverCents, region: q.region, nextDelivery: q.nextDeliveryLabel } }, input.contactName);
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
          const clean: BotData = { address: data.address, cep: data.cep, shipping: data.shipping };
          return {
            messages: [{
              body: `🎉 *Pedido ${result.code} recebido!*\nTotal: ${brl(result.totalCents)}` +
                (result.scheduledDelivery ? `\nEntrega prevista: ${dateBr(result.scheduledDelivery)}` : "") +
                `\n\nUm responsável vai te chamar por aqui para combinar o pagamento. Você recebe cada atualização do pedido neste número.\n\nDigite *menu* se precisar de algo mais.`,
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
