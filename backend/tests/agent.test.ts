import { describe, expect, test } from "bun:test";
import type { BetaMessage, MessageCreateParamsNonStreaming } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { runAgent, toMessages, type AgentDeps, type AgentOptions, type CatalogProduct, type HistoryItem } from "../src/lib/agent";
import type { BotData, BotProduct } from "../src/lib/bot";

// A IA aqui é um roteiro: cada chamada devolve a próxima resposta. Assim os testes provam as travas
// do sistema (estoque, preço, confirmação antes de fechar) sem rede e sem custo.

const PRODUCTS: BotProduct[] = [
  { id: 1, sku: "CAN-MC600", name: "Queijo Canastra Meia-Cura", unitLabel: "peça", weightGrams: 600, priceCents: 6890, availableUnits: 10 },
  { id: 2, sku: "TUL-180", name: "Queijo Tulha 180 dias", unitLabel: "peça", weightGrams: 1000, priceCents: 14900, availableUnits: 0 },
];
const CATALOG: CatalogProduct[] = [
  { sku: "CAN-MC600", name: "Queijo Canastra Meia-Cura", category: "Queijos Maturados", producer: "Fazenda Capão Grande", origin: "São Roque de Minas/MG", milk: "vaca", cureDays: 30, weightGrams: 600, unitLabel: "peça", priceCents: 6890, description: "Casca amarelada, massa macia.", detail: null, badge: null },
];

function fakeDeps(): AgentDeps & { placed: unknown[] } {
  const placed: unknown[] = [];
  return {
    placed,
    hours: "Seg a sex, 8h às 18h",
    catalog: async () => CATALOG,
    categories: async () => [],
    products: async () => PRODUCTS,
    productById: async (id) => PRODUCTS.find((p) => p.id === id) ?? null,
    productBySku: async (sku) => PRODUCTS.find((p) => p.sku === sku) ?? null,
    quoteCep: async (cep) => cep.startsWith("3")
      ? { ok: true, region: "Belo Horizonte e região", feeCents: 1990, freeShippingOverCents: 20000, nextDelivery: "2026-11-26", nextDeliveryLabel: "quinta-feira, 26/11/2026" }
      : { ok: false, message: "Ainda não entregamos no CEP 69000-000" },
    placeOrder: async (input) => { placed.push(input); return { ok: true, code: "PED-2026-000099", totalCents: 15770, shippingCents: 1990, scheduledDelivery: "2026-11-26" }; },
    recentOrders: async () => [],
  };
}

type Block = Record<string, unknown>;
const text = (t: string): Block => ({ type: "text", text: t });
const call = (name: string, input: Record<string, unknown> = {}): Block => ({ type: "tool_use", id: `t-${name}-${Math.random()}`, name, input });
const reply = (content: Block[], stop_reason = content.some((b) => b.type === "tool_use") ? "tool_use" : "end_turn") =>
  ({ id: "msg", type: "message", role: "assistant", model: "claude-opus-5-5", content, stop_reason, stop_details: null,
    usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 50, cache_creation_input_tokens: 0 } }) as unknown as BetaMessage;

function scripted(responses: BetaMessage[]) {
  const calls: MessageCreateParamsNonStreaming[] = [];
  const opts: AgentOptions = {
    model: "claude-opus-5-5",
    effort: "medium",
    create: async (params) => {
      calls.push(structuredClone(params));
      const next = responses.shift();
      if (!next) throw new Error("roteiro acabou");
      return next;
    },
  };
  return { opts, calls };
}

// Último bloco de resultados de ferramenta enviado à IA.
const lastToolResults = (params: MessageCreateParamsNonStreaming) => {
  const last = params.messages.at(-1)!;
  return (last.content as unknown as Block[]).filter((b) => b.type === "tool_result") as { content: string; is_error?: boolean }[];
};

const say = (history: HistoryItem[], body: string): HistoryItem[] => [...history, { author: "customer", body }];
const input = (history: HistoryItem[], data: BotData = {}) => ({ history, data, contactName: "Mariana Souza", today: "quarta-feira, 25/11/2026" });

describe("histórico da conversa", () => {
  test("junta mensagens seguidas, marca a equipe e começa pelo cliente", () => {
    const m = toMessages([
      { author: "bot", body: "Olá!" },
      { author: "customer", body: "oi" },
      { author: "customer", body: "tem canastra?" },
      { author: "agent", body: "Temos sim" },
    ]);
    expect(m).toEqual([
      { role: "user", content: "oi\n\ntem canastra?" },
      { role: "assistant", content: "[Atendente humano da loja] Temos sim" },
    ]);
  });
});

describe("robô vendedor com IA", () => {
  test("pedido completo: carrinho, frete, endereço, resumo e só fecha depois da confirmação", async () => {
    const deps = fakeDeps();
    let history = say([], "Quero 2 canastras, CEP 30130-000. Entrega para Mariana Souza, Rua das Flores 120, Centro, Belo Horizonte/MG, sem complemento");
    const t1 = scripted([
      reply([call("set_cart_item", { sku: "can-mc600", quantity: 2 }), call("quote_shipping", { cep: "30130-000" }),
        call("set_delivery_address", { recipient: "Mariana Souza", street: "Rua das Flores", number: "120", complement: "", district: "Centro", city: "Belo Horizonte", state: "mg" })]),
      reply([call("review_order")]),
      reply([call("place_order")]), // a IA tenta fechar na mesma mensagem: o sistema recusa
      reply([text("📋 Confira seu pedido… Posso confirmar?")]),
    ]);
    const r1 = await runAgent(input(history), deps, t1.opts);
    expect(deps.placed).toHaveLength(0);
    expect(lastToolResults(t1.calls[3]!)[0]).toMatchObject({ is_error: true });
    expect(lastToolResults(t1.calls[2]!)[0]!.content).toContain("R$ 157,70"); // 2 × 68,90 + frete 19,90
    expect(r1.data.cart).toEqual([expect.objectContaining({ sku: "CAN-MC600", quantity: 2, priceCents: 6890 })]);
    expect(r1.data.address?.state).toBe("MG");
    expect(r1.trace).toContain("fechou o pedido — recusado pelo sistema");

    history = say([...history, { author: "bot", body: r1.messages[0]!.body }], "Sim, pode confirmar");
    const t2 = scripted([reply([call("place_order")]), reply([text("🎉 Pedido PED-2026-000099 recebido!")])]);
    const r2 = await runAgent(input(history, r1.data), deps, t2.opts);
    expect(r2.orderCode).toBe("PED-2026-000099");
    expect(deps.placed[0]).toMatchObject({ cart: [{ productId: 1, quantity: 2 }], cep: "30130-000", address: { street: "Rua das Flores", state: "MG" } });
    expect(r2.data.cart).toEqual([]);
    expect(r2.state).toBe("ai");
  });

  test("se o carrinho muda depois do resumo, precisa de um resumo novo", async () => {
    const deps = fakeDeps();
    const data: BotData = {
      turn: 1,
      cart: [{ productId: 1, sku: "CAN-MC600", name: "Queijo Canastra Meia-Cura", unitLabel: "peça", priceCents: 6890, quantity: 2 }],
      cep: "30130-000",
      shipping: { feeCents: 1990, freeShippingOverCents: 20000, region: "BH", nextDelivery: null },
      address: { recipient: "Mariana", street: "Rua A", number: "1", complement: "", district: "Centro", city: "BH", state: "MG" },
    };
    const t1 = scripted([reply([call("review_order")]), reply([text("Confira…")])]);
    const r1 = await runAgent(input(say([], "fecha"), data), deps, t1.opts);
    const t2 = scripted([reply([call("set_cart_item", { sku: "CAN-MC600", quantity: 3 }), call("place_order")]), reply([text("Mudei para 3, confira o novo resumo")])]);
    await runAgent(input(say([], "põe 3 e fecha"), r1.data), deps, t2.opts);
    expect(deps.placed).toHaveLength(0);
    expect(lastToolResults(t2.calls[1]!)[1]).toMatchObject({ is_error: true });
  });

  test("estoque e esgotado vêm do sistema", async () => {
    const t = scripted([
      reply([call("set_cart_item", { sku: "CAN-MC600", quantity: 15 }), call("set_cart_item", { sku: "TUL-180", quantity: 1 }), call("set_cart_item", { sku: "XYZ", quantity: 1 })]),
      reply([text("Temos só 10 canastras e o Tulha esgotou.")]),
    ]);
    const r = await runAgent(input(say([], "quero 15 canastras e 1 tulha")), fakeDeps(), t.opts);
    const results = lastToolResults(t.calls[1]!);
    expect(results.every((x) => x.is_error)).toBe(true);
    expect(results[0]!.content).toContain("Só há 10");
    expect(results[1]!.content).toContain("esgotado");
    expect(r.data.cart ?? []).toEqual([]);
  });

  test("chamar uma pessoa: conversa vai para a fila com o motivo", async () => {
    const t = scripted([reply([call("handoff_to_human", { topic: "reclamacao", reason: "Queijo chegou quente" })]), reply([text("Sinto muito! Já chamei a equipe.")])]);
    const r = await runAgent(input(say([], "meu queijo chegou quente")), fakeDeps(), t.opts);
    expect(r.state).toBe("human");
    expect(r.handoff).toEqual({ topic: "reclamacao", reason: "IA: Queijo chegou quente" });
  });

  test("recusa do modelo vira atendimento humano", async () => {
    const t = scripted([reply([], "refusal")]);
    const r = await runAgent(input(say([], "...")), fakeDeps(), t.opts);
    expect(r.handoff?.topic).toBe("duvida");
    expect(r.messages[0]!.body).toContain("pessoa da equipe");
  });

  test("a chamada usa cache no bloco estável, fallback e ferramentas estritas", async () => {
    const t = scripted([reply([text("Oi, Mariana!")])]);
    await runAgent(input(say([], "oi")), fakeDeps(), t.opts);
    const p = t.calls[0]! as MessageCreateParamsNonStreaming & { system: { text: string; cache_control?: unknown }[] };
    expect(p.model).toBe("claude-opus-5-5");
    expect(p.system[0]!.cache_control).toEqual({ type: "ephemeral" });
    expect(p.system[0]!.text).toContain("[CAN-MC600] Queijo Canastra Meia-Cura — R$ 68,90");
    expect(p.system[1]!.cache_control).toBeUndefined();
    expect(p.system[1]!.text).toContain("Mariana Souza");
    expect(p).toMatchObject({ fallbacks: "default", betas: ["server-side-fallback-2026-07-01"], output_config: { effort: "medium" } });
    expect(p.tools!.every((tool) => "strict" in tool && tool.strict)).toBe(true);
  });

  test("pagamento que exige CPF: o resumo só sai com CPF válido", async () => {
    const deps = { ...fakeDeps(), needsDocument: true };
    const data: BotData = {
      cart: [{ productId: 1, sku: "CAN-MC600", name: "Queijo Canastra Meia-Cura", unitLabel: "peça", priceCents: 6890, quantity: 1 }],
      cep: "30130-000", shipping: { feeCents: 1990, freeShippingOverCents: null, region: "BH", nextDelivery: null },
      address: { recipient: "Mariana", street: "Rua A", number: "1", complement: "", district: "Centro", city: "BH", state: "MG" },
    };
    const t = scripted([
      reply([call("review_order"), call("set_customer_document", { document: "111.111.111-11" })]),
      reply([call("set_customer_document", { document: "529.982.247-25" }), call("review_order")]),
      reply([text("Confira o resumo…")]),
    ]);
    const r = await runAgent(input(say([], "pode fechar, meu cpf é 529.982.247-25"), data), deps, t.opts);
    expect(lastToolResults(t.calls[1]!).every((x) => x.is_error)).toBe(true);
    expect(t.calls[0]!.system).toBeDefined();
    expect((t.calls[0]! as unknown as { system: { text: string }[] }).system[1]!.text).toContain("exige CPF/CNPJ");
    expect(r.data.document).toBe("52998224725");
    expect(r.data.reviewed).toBeDefined();
  });

  test("reenviar o Pix: o código vai pelo sistema, depois do texto da IA", async () => {
    const deps = { ...fakeDeps(), lastPayment: async () => ({ orderCode: "PED-1", status: "pending" as const, automatic: true, messages: [{ body: "💳 Pagamento do pedido PED-1" }, { body: "000201PIX" }] }) };
    const t = scripted([reply([call("payment_status"), call("resend_payment_code")]), reply([text("Claro! Segue o Pix de novo:")])]);
    const r = await runAgent(input(say([], "pode mandar o pix de novo?")), deps, t.opts);
    expect(r.messages.map((m) => m.body)).toEqual(["Claro! Segue o Pix de novo:", "💳 Pagamento do pedido PED-1", "000201PIX"]);
    expect(lastToolResults(t.calls[1]!)[0]!.content).toContain("em aberto");
  });

  test("sem resposta final depois de muitas etapas: erro (o robô de regras assume)", async () => {
    const t = scripted(Array.from({ length: 8 }, () => reply([call("view_cart")])));
    await expect(runAgent(input(say([], "oi")), fakeDeps(), t.opts)).rejects.toThrow("limite de etapas");
  });
});
