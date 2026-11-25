import { describe, expect, test } from "bun:test";
import type { BetaMessage, MessageCreateParamsNonStreaming } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { catalogText, runAgent, systemPrompt, type AgentDeps } from "../src/lib/agent";
import { runBot, type BotData, type BotDeps } from "../src/lib/bot";
import { DEFAULT_BOT_CONFIG, matchFaq, renderGreeting, withDefaults, type BotConfig } from "../src/lib/botConfig";

type Over = Partial<Omit<BotConfig, "rules" | "persona">> & { rules?: Partial<BotConfig["rules"]>; persona?: Partial<BotConfig["persona"]> };
const cfg = (over: Over = {}): BotConfig =>
  withDefaults({ ...over, persona: { ...DEFAULT_BOT_CONFIG.persona, ...over.persona }, rules: { ...DEFAULT_BOT_CONFIG.rules, ...over.rules } });

const FAQS = [
  { id: "1", question: "Vocês entregam no interior?", answer: "Entregamos em BH e região metropolitana. Para o interior, consulte pelo CEP.", keywords: ["interior", "entregam em"] },
  { id: "2", question: "Queijo tem lactose?", answer: "Queijos curados têm muito pouca lactose.", keywords: ["lactose", "intolerante"] },
];

describe("configuração do robô", () => {
  test("saudação com e sem nome", () => {
    expect(renderGreeting("Olá{, nome}! Tudo bem?", "Mariana")).toBe("Olá, Mariana! Tudo bem?");
    expect(renderGreeting("Olá{, nome}! Tudo bem?", "")).toBe("Olá! Tudo bem?");
  });

  test("pergunta frequente pela palavra-chave, sem acento e sem diferenciar maiúsculas", () => {
    expect(matchFaq("Sou INTOLERANTE, posso comer?", FAQS)?.id).toBe("2");
    expect(matchFaq("vocês entregam em Contagem?", FAQS)?.id).toBe("1");
    expect(matchFaq("quero 2 canastras", FAQS)).toBeUndefined();
    expect(matchFaq("lactosee", FAQS)).toBeUndefined(); // palavra inteira
  });

  test("configuração antiga ganha os campos novos", () => {
    const c = withDefaults({ persona: { name: "Zita" } } as Partial<BotConfig>);
    expect(c.persona).toMatchObject({ name: "Zita", tone: "acolhedor", emojis: true });
    expect(c.rules.maxDiscountPct).toBe(0);
  });
});

// ---------- robô de regras ----------

const PRODUCT = { id: 1, sku: "CAN-MC600", name: "Queijo Canastra Meia-Cura", unitLabel: "peça", weightGrams: 600, priceCents: 6890, availableUnits: 10 };
const deps = (config?: BotConfig): BotDeps => ({
  hours: "Seg a sex, 8h às 18h",
  config,
  categories: async () => [{ slug: "q", name: "Queijos" }],
  products: async () => [PRODUCT],
  productById: async () => PRODUCT,
  productBySku: async () => PRODUCT,
  quoteCep: async () => ({ ok: true, region: "BH", feeCents: 1990, freeShippingOverCents: 20000, nextDelivery: null, nextDeliveryLabel: null }),
  placeOrder: async () => ({ ok: true, code: "PED-1", totalCents: 1, shippingCents: 0, scheduledDelivery: null }),
  recentOrders: async () => [],
});

async function chat(texts: string[], d: BotDeps) {
  let state = "start"; let data: BotData = {}; const replies: string[] = []; let last;
  for (const text of texts) {
    last = await runBot({ state, data, text, contactName: "Mariana Souza" }, d);
    state = last.state; data = last.data; replies.push(...last.messages.map((m) => m.body));
  }
  return { state, replies, last: last! };
}

describe("robô de regras com a Central", () => {
  test("saudação dos donos e resposta de pergunta frequente", async () => {
    const r = await chat(["oi, sou intolerante a lactose, posso comer?"], deps(cfg({ faqs: FAQS, persona: { greeting: "Bom dia{, nome}! Aqui é a Zita." } })));
    expect(r.replies[0]).toBe("Bom dia, Mariana! Aqui é a Zita.");
    expect(r.replies[1]).toContain("muito pouca lactose");
    expect(r.state).toBe("menu");
  });

  test("palavra que chama a equipe", async () => {
    const r = await chat(["oi", "quero falar sobre nota fiscal"], deps(cfg({ rules: { handoffKeywords: ["nota fiscal"] } })));
    expect(r.last.handoff?.reason).toContain("nota fiscal");
  });

  test("sem emojis, se os donos preferirem", async () => {
    const r = await chat(["oi"], deps(cfg({ persona: { emojis: false } })));
    expect(r.replies.join(" ")).not.toMatch(/\p{Extended_Pictographic}/u);
  });

  test("pedido mínimo segura o fechamento", async () => {
    const r = await chat(["oi", "1", "1", "1", "1", "2"], deps(cfg({ rules: { minOrderCents: 10000 } })));
    expect(r.state).toBe("cart");
    expect(r.replies.at(-1)).toContain("O pedido mínimo é de R$ 100,00");
  });

  test("pergunta não entendida vai para a Central", async () => {
    const r = await chat(["oi", "vocês fazem cesta de presente personalizada?"], deps());
    expect(r.last.unanswered).toBe("vocês fazem cesta de presente personalizada?");
  });
});

// ---------- robô com IA ----------

const agentDeps = (config: BotConfig): AgentDeps => ({ ...deps(config), catalog: async () => [] });
const reply = (content: Record<string, unknown>[], stop_reason = content.some((b) => b.type === "tool_use") ? "tool_use" : "end_turn") =>
  ({ id: "m", type: "message", role: "assistant", model: "claude-opus-5-5", content, stop_reason, stop_details: null, usage: { input_tokens: 1, output_tokens: 1 } }) as unknown as BetaMessage;
const call = (name: string, input: Record<string, unknown> = {}) => ({ type: "tool_use", id: `t-${name}-${Math.random()}`, name, input });

function scripted(responses: BetaMessage[]) {
  const calls: MessageCreateParamsNonStreaming[] = [];
  return { calls, opts: { model: "claude-opus-5-5", effort: "medium" as const, create: async (p: MessageCreateParamsNonStreaming) => { calls.push(structuredClone(p)); return responses.shift()!; } } };
}
const toolResults = (p: MessageCreateParamsNonStreaming) => (p.messages.at(-1)!.content as unknown as { type: string; content: string; is_error?: boolean }[]).filter((b) => b.type === "tool_result");
const input = (data: BotData = {}) => ({ history: [{ author: "customer" as const, body: "oi" }], data, contactName: "Mariana", today: "hoje" });

const READY: BotData = {
  cart: [{ productId: 1, sku: "CAN-MC600", name: "Queijo Canastra Meia-Cura", unitLabel: "peça", priceCents: 10000, quantity: 1 }],
  cep: "30130-000", shipping: { feeCents: 1990, freeShippingOverCents: null, region: "BH", nextDelivery: null },
  address: { recipient: "Mariana", street: "Rua A", number: "1", complement: "", district: "Centro", city: "BH", state: "MG" },
};

describe("robô com IA e a Central", () => {
  test("instruções usam tom, conhecimento, perguntas frequentes e orientações dos donos", () => {
    const c = cfg({
      persona: { name: "Zita", tone: "formal", emojis: false },
      faqs: FAQS,
      products: { "CAN-MC600": { fabrication: "Leite cru, coalho natural, prensagem manual.", pairing: "Vinho tinto leve", storage: "", notes: "" } },
      rules: { extraInstructions: "Sempre lembre que fechamos aos domingos.", upsell: false },
    });
    const p = systemPrompt(catalogText([{ sku: "CAN-MC600", name: "Canastra", category: "Queijos", producer: "Fazenda", origin: "MG", milk: "vaca", cureDays: 30, weightGrams: 600, unitLabel: "peça", priceCents: 6890, description: null, detail: null, badge: null }], c.products), c);
    expect(p).toContain("Zita, a atendente virtual");
    expect(p).toContain("cordial e profissional");
    expect(p).toContain("Não use emojis.");
    expect(p).toContain("Fabricação: Leite cru, coalho natural");
    expect(p).toContain("Harmoniza com: Vinho tinto leve");
    expect(p).toContain("R: Queijos curados têm muito pouca lactose.");
    expect(p).toContain("fechamos aos domingos");
    expect(p).toContain("Não ofereça produtos além");
    expect(p).toContain("não pode dar descontos");
  });

  test("desconto só existe dentro do limite dos donos e entra no resumo", async () => {
    const off = scripted([reply([{ type: "text", text: "oi" }])]);
    await runAgent(input(), agentDeps(cfg()), off.opts);
    expect(off.calls[0]!.tools!.some((t) => "name" in t && t.name === "apply_discount")).toBe(false);

    const t = scripted([
      reply([call("apply_discount", { percent: 15, reason: "pediu" }), call("apply_discount", { percent: 5, reason: "pediu" }), call("review_order")]),
      reply([{ type: "text", text: "Confira" }]),
    ]);
    const r = await runAgent(input({ ...READY, turn: 1 }), agentDeps(cfg({ rules: { maxDiscountPct: 10 } })), t.opts);
    const [over, ok, review] = toolResults(t.calls[1]!);
    expect(over!.is_error).toBe(true);
    expect(over!.content).toContain("limite da loja é 10%");
    expect(ok!.is_error).toBeUndefined();
    expect(review!.content).toContain("Desconto (5%): −R$ 5,00");
    expect(review!.content).toContain("R$ 114,90"); // 100,00 − 5,00 + 19,90
    expect(r.data.discountPct).toBe(5);
  });

  test("pedido mínimo bloqueia o resumo", async () => {
    const t = scripted([reply([call("review_order")]), reply([{ type: "text", text: "Faltam" }])]);
    await runAgent(input(READY), agentDeps(cfg({ rules: { minOrderCents: 15000 } })), t.opts);
    expect(toolResults(t.calls[1]!)[0]).toMatchObject({ is_error: true });
    expect(toolResults(t.calls[1]!)[0]!.content).toContain("Faltam R$ 50,00");
  });

  test("pergunta sem resposta vai para a Central", async () => {
    const t = scripted([reply([call("log_unanswered_question", { question: "Vocês fazem cesta personalizada?" }), call("handoff_to_human", { topic: "duvida", reason: "cesta" })]), reply([{ type: "text", text: "Vou confirmar com a equipe." }])]);
    const r = await runAgent(input(), agentDeps(cfg()), t.opts);
    expect(r.unanswered).toBe("Vocês fazem cesta personalizada?");
    expect(r.handoff?.topic).toBe("duvida");
  });
});
