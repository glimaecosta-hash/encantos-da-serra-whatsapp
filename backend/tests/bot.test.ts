import { describe, expect, test } from "bun:test";
import { parseCityState, parseQuantity, pickOption, runBot, skuFromSiteMessage, type BotData, type BotDeps, type BotProduct } from "../src/lib/bot";

const PRODUCTS: BotProduct[] = [
  { id: 1, sku: "CAN-MC600", name: "Queijo Canastra Meia-Cura", unitLabel: "peça", weightGrams: 600, priceCents: 6890, availableUnits: 10 },
  { id: 2, sku: "TUL-180", name: "Queijo Tulha 180 dias", unitLabel: "peça", weightGrams: 1000, priceCents: 14900, availableUnits: 0 },
];

function fakeDeps(over: Partial<BotDeps> = {}): BotDeps & { placed: unknown[] } {
  const placed: unknown[] = [];
  return {
    placed,
    hours: "Seg a sex, 8h às 18h",
    categories: async () => [{ slug: "queijos-maturados", name: "Queijos Maturados" }],
    products: async () => PRODUCTS,
    productById: async (id) => PRODUCTS.find((p) => p.id === id) ?? null,
    productBySku: async (sku) => PRODUCTS.find((p) => p.sku === sku) ?? null,
    quoteCep: async (cep) => cep.startsWith("3")
      ? { ok: true, region: "Belo Horizonte e região", feeCents: 1990, freeShippingOverCents: 20000, nextDelivery: "2026-11-26", nextDeliveryLabel: "quinta-feira, 26/11/2026" }
      : { ok: false, message: "Ainda não entregamos no CEP 69000-000" },
    placeOrder: async (input) => { placed.push(input); return { ok: true, code: "PED-2026-000099", totalCents: 15770, shippingCents: 1990, scheduledDelivery: "2026-11-26" }; },
    recentOrders: async () => [],
    ...over,
  };
}

// Roda uma sequência de mensagens e devolve o estado final + todas as respostas.
async function chat(texts: string[], deps = fakeDeps(), name: string | null = "Mariana Souza") {
  let state = "start";
  let data: BotData = {};
  const replies: string[] = [];
  let last;
  for (const text of texts) {
    last = await runBot({ state, data, text, contactName: name }, deps);
    state = last.state;
    data = last.data;
    replies.push(...last.messages.map((m) => m.body));
  }
  return { state, data, replies, last: last!, deps };
}

describe("entrada do cliente", () => {
  test("opção por número ou por palavra", () => {
    const opts = [{ key: "1", label: "Adicionar mais produtos" }, { key: "2", label: "Finalizar pedido" }];
    expect(pickOption("2", opts)?.key).toBe("2");
    expect(pickOption("opção 1", opts)?.key).toBe("1");
    expect(pickOption("finalizar", opts)?.key).toBe("2");
    expect(pickOption("xyz", opts)).toBeUndefined();
  });
  test("quantidade em número ou por extenso", () => {
    expect(parseQuantity("3")).toBe(3);
    expect(parseQuantity("duas")).toBe(2);
    expect(parseQuantity("2 peças")).toBe(2);
    expect(parseQuantity("muitas")).toBeUndefined();
  });
  test("cidade e estado", () => {
    expect(parseCityState("Belo Horizonte/MG")).toEqual({ city: "Belo Horizonte", state: "MG" });
    expect(parseCityState("Piumhi - mg")).toEqual({ city: "Piumhi", state: "MG" });
    expect(parseCityState("Belo Horizonte")).toBeUndefined();
  });
  test("código do produto na mensagem pronta do site", () => {
    expect(skuFromSiteMessage("Olá! Quero pedir Queijo Canastra (cód. CAN-MC600)")).toBe("CAN-MC600");
  });
});

describe("fluxo de compra", () => {
  test("primeira mensagem: saudação pelo nome e menu", async () => {
    const r = await chat(["oi"]);
    expect(r.state).toBe("menu");
    expect(r.replies[0]).toContain("Olá, Mariana");
    expect(r.replies[1]).toContain("Ver produtos e fazer um pedido");
  });

  test("pedido completo pelo bot", async () => {
    const r = await chat(["oi", "1", "1", "1", "2", "2", "30130-000", "Rua das Flores, 120", "Centro", "Belo Horizonte/MG", "não", "1"]);
    expect(r.last.orderCode).toBe("PED-2026-000099");
    expect(r.deps.placed[0]).toMatchObject({
      cart: [{ productId: 1, quantity: 2 }],
      cep: "30130-000",
      address: { recipient: "Mariana Souza", street: "Rua das Flores", number: "120", district: "Centro", city: "Belo Horizonte", state: "MG" },
    });
    expect(r.replies.some((b) => b.includes("Confira seu pedido") && b.includes("R$ 137,80"))).toBe(true);
    expect(r.data.cart).toBeUndefined();
  });

  test("produto esgotado não entra no carrinho", async () => {
    const r = await chat(["oi", "1", "1", "2"]);
    expect(r.state).toBe("products");
    expect(r.replies.at(-2)).toContain("esgotado");
  });

  test("não deixa pedir mais que o estoque", async () => {
    const r = await chat(["oi", "1", "1", "1", "15"]);
    expect(r.state).toBe("quantity");
    expect(r.replies.at(-1)).toContain("Temos só *10*");
  });

  test("link do site já abre o produto", async () => {
    const r = await chat(["Olá! Quero pedir Queijo Canastra Meia-Cura (cód. CAN-MC600)"]);
    expect(r.state).toBe("quantity");
  });

  test("link da página do produto com quantidade já monta o carrinho", async () => {
    const r = await chat(["Olá! Quero pedir 3 peças de Queijo Canastra Meia-Cura (cód. CAN-MC600)"]);
    expect(r.state).toBe("cart");
    expect(r.data.cart).toEqual([expect.objectContaining({ productId: 1, quantity: 3 })]);
  });

  test("CEP fora da área oferece atendente", async () => {
    const r = await chat(["oi", "1", "1", "1", "1", "2", "69000000", "2"]);
    expect(r.last.handoff?.topic).toBe("compra");
  });
});

describe("transferência para o responsável", () => {
  test("cliente pede atendente em qualquer etapa", async () => {
    const r = await chat(["oi", "1", "atendente"]);
    expect(r.last.handoff?.topic).toBe("duvida");
    expect(r.state).toBe("human");
  });

  test("atacado coleta a necessidade e transfere", async () => {
    const r = await chat(["oi", "3", "Restaurante em BH, 10 caixas de canastra por mês"]);
    expect(r.last.handoff).toMatchObject({ topic: "atacado" });
    expect(r.last.handoff?.reason).toContain("10 caixas");
  });

  test("reclamação vai direto para uma pessoa", async () => {
    const r = await chat(["oi", "meu queijo chegou quente"]);
    expect(r.last.handoff?.topic).toBe("reclamacao");
  });

  test("depois de 3 respostas sem sentido, chama um atendente", async () => {
    const r = await chat(["oi", "banana", "banana", "banana"]);
    expect(r.last.handoff).toBeDefined();
  });
});
