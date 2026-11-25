import { describe, expect, test } from "bun:test";
import { isValidCpf } from "../src/lib/cnpj";
import { asaas, efi, manualPix, mercadoPago, ProviderError, type ChargeInput } from "../src/lib/paymentProviders";
import { crc16, isValidPixKey, pixCopyPaste } from "../src/lib/pix";
import { runBot, type BotData, type BotDeps, type PaymentInfo } from "../src/lib/bot";

describe("Pix copia e cola (BR Code)", () => {
  test("bate com o exemplo do manual do Banco Central", () => {
    const ex = "00020126580014br.gov.bcb.pix0136123e4567-e12b-12d1-a456-4266554400005204000053039865802BR5913Fulano de Tal6008BRASILIA62070503***6304";
    expect(crc16(ex)).toBe("1D3D");
    expect(pixCopyPaste({ key: "123e4567-e12b-12d1-a456-426655440000", name: "Fulano de Tal", city: "BRASILIA" })).toBe(`${ex}1D3D`);
  });

  test("com valor, txid e nome acentuado", () => {
    const code = pixCopyPaste({ key: "contato@encantos.com.br", name: "Laticínios São José", city: "São Roque de Minas", amountCents: 15770, txid: "ES12XABC", description: "Pedido PED-1" });
    expect(code).toContain("5406157.70");
    expect(code).toContain("5919Laticinios Sao Jose");
    expect(code).toContain("6015Sao Roque de Mi");
    expect(code).toContain("62120508ES12XABC");
    expect(code.slice(-4)).toBe(crc16(code.slice(0, -4)));
  });

  test("chaves Pix e CPF", () => {
    expect(isValidPixKey("contato@encantos.com.br")).toBe(true);
    expect(isValidPixKey("+5531999990000")).toBe(true);
    expect(isValidPixKey("12345678909")).toBe(true);
    expect(isValidPixKey("31 9999-0000")).toBe(false);
    expect(isValidCpf("529.982.247-25")).toBe(true);
    expect(isValidCpf("111.111.111-11")).toBe(false);
    expect(isValidCpf("529.982.247-24")).toBe(false);
  });
});

// "Internet" falsa: registra cada chamada e responde pelo roteiro.
function fakeFetch(routes: Record<string, (body: any, init: RequestInit & { tls?: unknown }) => unknown>) {
  const calls: { method: string; url: string; body: any; headers: Record<string, string>; tls?: unknown }[] = [];
  const fn = async (url: string, init: RequestInit & { tls?: unknown } = {}) => {
    const method = init.method ?? "GET";
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, url, body, headers: init.headers as Record<string, string>, tls: init.tls });
    const key = Object.keys(routes).find((k) => `${method} ${url}`.startsWith(k));
    if (!key) return new Response(JSON.stringify({ message: "rota não prevista" }), { status: 404 });
    return new Response(JSON.stringify(routes[key]!(body, init)), { status: 200 });
  };
  return { fn, calls };
}

const input = (over: Partial<ChargeInput> = {}): ChargeInput => ({
  reference: "ES12XABCDEFGH",
  orderCode: "PED-2026-000099",
  amountCents: 15770,
  description: "Pedido PED-2026-000099 - Encantos da Serra",
  expiresAt: new Date(Date.now() + 120 * 60_000),
  customer: { name: "Mariana Souza", phone: "5531988887777", email: "mariana@exemplo.com" },
  items: [{ title: "Pedido PED-2026-000099", quantity: 1, unitPriceCents: 15770 }],
  cardLink: true,
  ...over,
});

describe("provedores", () => {
  test("Pix da loja: precisa da chave, não confirma sozinho", async () => {
    expect(manualPix({ pixKey: "", merchantName: "x", merchantCity: "y" }).missing).toHaveLength(1);
    const p = manualPix({ pixKey: "contato@encantos.com.br", merchantName: "Encantos da Serra", merchantCity: "BH" });
    const c = await p.createCharge(input());
    expect(c.pixCode).toContain("br.gov.bcb.pix");
    expect(c.pixCode).toContain("5406157.70");
    expect(p.automatic).toBe(false);
  });

  test("Mercado Pago: Pix pela API de pedidos + link de cartão; pago = processed/accredited", async () => {
    const f = fakeFetch({
      "POST https://api.mercadopago.com/v1/orders": () => ({ id: "ORD01", transactions: { payments: [{ payment_method: { qr_code: "000201PIXMP" } }] } }),
      "POST https://api.mercadopago.com/checkout/preferences": () => ({ id: "pref", init_point: "https://mp/checkout" }),
      "GET https://api.mercadopago.com/v1/orders/ORD01": () => ({ status: "processed", status_detail: "accredited" }),
    });
    const mp = mercadoPago({ accessToken: "TEST-123" }, f.fn);
    const c = await mp.createCharge(input({ notificationUrl: "https://loja/api/payments/webhooks/mercadopago" }));
    expect(c).toEqual({ externalId: "ORD01", pixCode: "000201PIXMP", paymentUrl: "https://mp/checkout" });
    const order = f.calls[0]!;
    expect(order.headers["X-Idempotency-Key"]).toBe("ES12XABCDEFGH");
    expect(order.headers.Authorization).toBe("Bearer TEST-123");
    expect(order.body).toMatchObject({ type: "online", total_amount: "157.70", external_reference: "ES12XABCDEFGH", transactions: { payments: [{ amount: "157.70", payment_method: { id: "pix", type: "bank_transfer" } }] } });
    expect(f.calls[1]!.body).toMatchObject({ items: [{ quantity: 1, unit_price: 157.7, currency_id: "BRL" }], notification_url: "https://loja/api/payments/webhooks/mercadopago" });
    expect(await mp.checkStatus("ORD01")).toBe("paid");
  });

  test("Mercado Pago: expirado vira expired", async () => {
    const f = fakeFetch({ "GET https://api.mercadopago.com/v1/orders/X": () => ({ status: "canceled", status_detail: "expired" }) });
    expect(await mercadoPago({ accessToken: "t" }, f.fn).checkStatus("X")).toBe("expired");
  });

  test("Asaas: exige CPF, reaproveita cliente, cobrança + Pix; pago = RECEIVED/CONFIRMED", async () => {
    const a0 = asaas({ apiKey: "k", sandbox: true }, fakeFetch({}).fn);
    await expect(a0.createCharge(input())).rejects.toBeInstanceOf(ProviderError);

    const f = fakeFetch({
      "GET https://api-sandbox.asaas.com/v3/customers?cpfCnpj=52998224725": () => ({ data: [] }),
      "POST https://api-sandbox.asaas.com/v3/customers": () => ({ id: "cus_1" }),
      "POST https://api-sandbox.asaas.com/v3/payments": () => ({ id: "pay_1", invoiceUrl: "https://asaas/i/pay_1" }),
      "GET https://api-sandbox.asaas.com/v3/payments/pay_1/pixQrCode": () => ({ payload: "000201PIXASAAS" }),
      "GET https://api-sandbox.asaas.com/v3/payments/pay_1": () => ({ status: "RECEIVED" }),
    });
    const a = asaas({ apiKey: "k", sandbox: true }, f.fn);
    const c = await a.createCharge(input({ customer: { ...input().customer, document: "52998224725" } }));
    expect(c).toEqual({ externalId: "pay_1", pixCode: "000201PIXASAAS", paymentUrl: "https://asaas/i/pay_1" });
    expect(f.calls[0]!.headers.access_token).toBe("k");
    expect(f.calls[1]!.body).toMatchObject({ name: "Mariana Souza", cpfCnpj: "52998224725", mobilePhone: "31988887777" });
    expect(f.calls[2]!.body).toMatchObject({ customer: "cus_1", billingType: "UNDEFINED", value: 157.7, externalReference: "ES12XABCDEFGH" });
    expect(f.calls[2]!.body.dueDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(await a.checkStatus("pay_1")).toBe("paid");
  });

  test("Efí: token com certificado, cobrança imediata; pago = CONCLUIDA", async () => {
    const f = fakeFetch({
      "POST https://pix-h.api.efipay.com.br/oauth/token": () => ({ access_token: "tok", expires_in: 3600 }),
      "POST https://pix-h.api.efipay.com.br/v2/cob": () => ({ txid: "tx1", status: "ATIVA", pixCopiaECola: "000201PIXEFI" }),
      "GET https://pix-h.api.efipay.com.br/v2/cob/tx1": () => ({ status: "CONCLUIDA" }),
    });
    const e = efi({ clientId: "id", clientSecret: "sec", cert: "CERT", key: "KEY", pixKey: "chave@loja.com", sandbox: true }, f.fn);
    const c = await e.createCharge(input());
    expect(c).toEqual({ externalId: "tx1", pixCode: "000201PIXEFI", paymentUrl: null });
    expect(f.calls[0]!.headers.Authorization).toBe(`Basic ${Buffer.from("id:sec").toString("base64")}`);
    expect(f.calls[0]!.tls).toEqual({ cert: "CERT", key: "KEY" });
    expect(f.calls[1]!.body).toMatchObject({ valor: { original: "157.70" }, chave: "chave@loja.com" });
    expect(f.calls[1]!.headers.Authorization).toBe("Bearer tok");
    expect(await e.checkStatus("tx1")).toBe("paid");
    expect(f.calls.filter((x) => x.url.endsWith("/oauth/token"))).toHaveLength(1); // token reaproveitado
  });

  test("erro do provedor vira mensagem clara", async () => {
    const f = { fn: async () => new Response(JSON.stringify({ message: "invalid_credentials" }), { status: 401 }) };
    await expect(mercadoPago({ accessToken: "x" }, f.fn).createCharge(input())).rejects.toThrow("HTTP 401 — invalid_credentials");
  });
});

// ---------- robô de regras: CPF e "já paguei" ----------

const PRODUCT = { id: 1, sku: "CAN-MC600", name: "Queijo Canastra Meia-Cura", unitLabel: "peça", weightGrams: 600, priceCents: 6890, availableUnits: 10 };

function deps(over: Partial<BotDeps> = {}): BotDeps {
  return {
    hours: "Seg a sex, 8h às 18h",
    categories: async () => [{ slug: "q", name: "Queijos" }],
    products: async () => [PRODUCT],
    productById: async () => PRODUCT,
    productBySku: async () => PRODUCT,
    quoteCep: async () => ({ ok: true, region: "BH", feeCents: 1990, freeShippingOverCents: 20000, nextDelivery: null, nextDeliveryLabel: null }),
    placeOrder: async () => ({ ok: true, code: "PED-1", totalCents: 15770, shippingCents: 1990, scheduledDelivery: null }),
    recentOrders: async () => [],
    ...over,
  };
}

async function chat(texts: string[], d: BotDeps, state = "start", data: BotData = {}) {
  const replies: string[] = [];
  let last;
  for (const text of texts) {
    last = await runBot({ state, data, text, contactName: "Mariana" }, d);
    state = last.state; data = last.data;
    replies.push(...last.messages.map((m) => m.body));
  }
  return { state, data, replies, last: last! };
}

describe("robô de regras e pagamento", () => {
  const flow = ["oi", "1", "1", "1", "2", "2", "30130-000", "Rua das Flores, 120", "Centro", "Belo Horizonte/MG", "não"];

  test("provedor que exige CPF: pergunta antes do resumo e valida", async () => {
    const r = await chat([...flow, "123", "529.982.247-25"], deps({ needsDocument: true }));
    expect(r.replies).toContainEqual(expect.stringContaining("preciso do seu *CPF*"));
    expect(r.replies).toContainEqual(expect.stringContaining("não parece válido"));
    expect(r.state).toBe("confirm");
    expect(r.data.document).toBe("52998224725");
    const done = await chat(["1"], deps({ needsDocument: true }), r.state, r.data);
    expect(done.last.orderCode).toBe("PED-1");
    expect(done.data.document).toBe("52998224725");
  });

  test("sem exigência de CPF, vai direto ao resumo", async () => {
    const r = await chat(flow, deps());
    expect(r.state).toBe("confirm");
  });

  const pay = (p: Partial<PaymentInfo>): BotDeps => deps({ lastPayment: async () => ({ orderCode: "PED-1", status: "pending", automatic: true, messages: [{ body: "intro" }, { body: "000201PIX" }], ...p }) });

  test("'já paguei' com confirmação automática: explica e reenvia o código", async () => {
    const r = await chat(["oi", "já paguei"], pay({}));
    expect(r.replies.at(-2)).toContain("Ainda não recebi a confirmação");
    expect(r.replies.at(-1)).toBe("000201PIX");
  });

  test("'comprovante' com Pix da loja: chama a equipe para conferir", async () => {
    const r = await chat(["oi", "segue o comprovante"], pay({ automatic: false }));
    expect(r.last.handoff).toMatchObject({ topic: "pedido" });
  });

  test("pago e vencido", async () => {
    expect((await chat(["oi", "paguei"], pay({ status: "paid" }))).replies.at(-1)).toContain("já está confirmado");
    expect((await chat(["oi", "paguei"], pay({ status: "expired" }))).replies.at(-1)).toContain("foi cancelado");
  });
});
