import { pixCopyPaste } from "./pix";

// Provedores de pagamento. Cada um cria a cobrança (Pix e, quando houver, link de cartão) e informa a situação.
// A confirmação nunca confia no aviso (webhook) recebido: o sistema sempre consulta a cobrança no provedor.
//
// Endpoints conferidos na documentação oficial (nov/2026):
// - Mercado Pago: POST/GET /v1/orders (Pix) e POST /checkout/preferences (link de cartão); GET /v1/payments/{id}.
// - Asaas: /v3/customers, /v3/payments, /v3/payments/{id}/pixQrCode; header access_token.
// - Efí: OAuth em /oauth/token com mTLS; POST /v2/cob, GET /v2/cob/{txid}.

export type ProviderId = "manual_pix" | "mercadopago" | "asaas" | "efi";

export type ChargeInput = {
  reference: string;      // nosso identificador único (letras e números, até 25)
  orderCode: string;
  amountCents: number;
  description: string;
  expiresAt: Date;
  customer: { name: string; phone: string; email: string; document?: string };
  items: { title: string; quantity: number; unitPriceCents: number }[];
  cardLink: boolean;      // gerar também link para pagar com cartão, quando o provedor tiver
  notificationUrl?: string;
};

export type Charge = { externalId: string | null; pixCode: string | null; paymentUrl: string | null };
export type ChargeStatus = "pending" | "paid" | "expired" | "cancelled" | "failed";

export type Provider = {
  id: ProviderId;
  label: string;
  automatic: boolean;     // confirma sozinho (consulta ao provedor) ou depende da equipe
  needsDocument: boolean; // exige CPF/CNPJ do pagador
  missing: string[];      // configurações que faltam no .env / painel
  createCharge(input: ChargeInput): Promise<Charge>;
  checkStatus(externalId: string): Promise<ChargeStatus>;
};

export class ProviderError extends Error {}

type Fetch = (url: string, init?: RequestInit & { tls?: { cert?: string; key?: string } }) => Promise<Response>;

async function json(res: Response, what: string) {
  const text = await res.text();
  let body: any = null;
  try { body = text ? JSON.parse(text) : null; } catch { /* resposta não-JSON */ }
  if (!res.ok) {
    const msg = body?.message ?? body?.errors?.[0]?.description ?? body?.mensagem ?? body?.nome ?? text.slice(0, 200);
    throw new ProviderError(`${what}: HTTP ${res.status}${msg ? ` — ${msg}` : ""}`);
  }
  return body;
}

const reais = (cents: number) => (cents / 100).toFixed(2);

// ---------- Pix copia e cola da loja (sem provedor) ----------

export function manualPix(cfg: { pixKey: string; merchantName: string; merchantCity: string }): Provider {
  return {
    id: "manual_pix",
    label: "Pix copia e cola (confirmação pela equipe)",
    automatic: false,
    needsDocument: false,
    missing: cfg.pixKey ? [] : ["chave Pix (Pagamentos no painel)"],
    async createCharge(i) {
      if (!cfg.pixKey) throw new ProviderError("Chave Pix não configurada");
      return {
        externalId: null,
        pixCode: pixCopyPaste({ key: cfg.pixKey, name: cfg.merchantName, city: cfg.merchantCity, amountCents: i.amountCents, txid: i.reference, description: `Pedido ${i.orderCode}` }),
        paymentUrl: null,
      };
    },
    async checkStatus() { return "pending"; },
  };
}

// ---------- Mercado Pago ----------

export function mercadoPago(cfg: { accessToken?: string }, fetchImpl: Fetch = fetch): Provider {
  const api = "https://api.mercadopago.com";
  const headers = () => ({ Authorization: `Bearer ${cfg.accessToken}`, "Content-Type": "application/json" });
  return {
    id: "mercadopago",
    label: "Mercado Pago (Pix e cartão, confirmação automática)",
    automatic: true,
    needsDocument: false,
    missing: cfg.accessToken ? [] : ["MP_ACCESS_TOKEN no .env"],
    async createCharge(i) {
      if (!cfg.accessToken) throw new ProviderError("MP_ACCESS_TOKEN não configurado");
      const minutes = Math.max(30, Math.round((i.expiresAt.getTime() - Date.now()) / 60_000));
      const order = await json(await fetchImpl(`${api}/v1/orders`, {
        method: "POST",
        headers: { ...headers(), "X-Idempotency-Key": i.reference },
        body: JSON.stringify({
          type: "online",
          processing_mode: "automatic",
          external_reference: i.reference,
          total_amount: reais(i.amountCents),
          description: i.description,
          payer: { email: i.customer.email },
          transactions: { payments: [{ amount: reais(i.amountCents), payment_method: { id: "pix", type: "bank_transfer" }, expiration_time: `PT${minutes}M` }] },
        }),
      }), "Mercado Pago (criar Pix)");
      const pixCode = order?.transactions?.payments?.[0]?.payment_method?.qr_code ?? null;
      if (!order?.id || !pixCode) throw new ProviderError("Mercado Pago não devolveu o Pix copia e cola");

      let paymentUrl: string | null = null;
      if (i.cardLink) {
        const pref = await json(await fetchImpl(`${api}/checkout/preferences`, {
          method: "POST",
          headers: headers(),
          body: JSON.stringify({
            items: i.items.map((it) => ({ title: it.title, quantity: it.quantity, unit_price: it.unitPriceCents / 100, currency_id: "BRL" })),
            external_reference: i.reference,
            ...(i.notificationUrl ? { notification_url: i.notificationUrl } : {}),
            expires: true,
            expiration_date_to: i.expiresAt.toISOString(),
          }),
        }), "Mercado Pago (link de cartão)");
        paymentUrl = pref?.init_point ?? null;
      }
      return { externalId: String(order.id), pixCode, paymentUrl };
    },
    async checkStatus(externalId) {
      const o = await json(await fetchImpl(`${api}/v1/orders/${encodeURIComponent(externalId)}`, { headers: headers() }), "Mercado Pago (consultar)");
      if (o?.status === "processed" && o?.status_detail === "accredited") return "paid";
      if (o?.status === "canceled" || o?.status === "failed") return o?.status_detail === "expired" ? "expired" : "cancelled";
      return "pending";
    },
  };
}

// Pagamento com cartão pelo link (Checkout Pro) chega como aviso do tipo "payment".
export async function mercadoPagoCardPayment(accessToken: string, paymentId: string, fetchImpl: Fetch = fetch) {
  const p = await json(await fetchImpl(`https://api.mercadopago.com/v1/payments/${encodeURIComponent(paymentId)}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  }), "Mercado Pago (consultar pagamento)");
  return { reference: (p?.external_reference as string | undefined) ?? null, approved: p?.status === "approved" };
}

// ---------- Asaas ----------

export function asaas(cfg: { apiKey?: string; sandbox: boolean }, fetchImpl: Fetch = fetch): Provider {
  const api = cfg.sandbox ? "https://api-sandbox.asaas.com/v3" : "https://api.asaas.com/v3";
  const headers = () => ({ access_token: cfg.apiKey ?? "", "Content-Type": "application/json" });
  const get = async (path: string, what: string) => json(await fetchImpl(`${api}${path}`, { headers: headers() }), what);
  return {
    id: "asaas",
    label: `Asaas${cfg.sandbox ? " (sandbox)" : ""} (Pix, cartão e boleto, confirmação automática)`,
    automatic: true,
    needsDocument: true,
    missing: cfg.apiKey ? [] : ["ASAAS_API_KEY no .env"],
    async createCharge(i) {
      if (!cfg.apiKey) throw new ProviderError("ASAAS_API_KEY não configurada");
      if (!i.customer.document) throw new ProviderError("O Asaas exige o CPF ou CNPJ do cliente");
      // Reaproveita o cliente pelo CPF/CNPJ; senão, cria.
      const found = await get(`/customers?cpfCnpj=${i.customer.document}&limit=1`, "Asaas (buscar cliente)");
      let customerId: string | undefined = found?.data?.[0]?.id;
      if (!customerId) {
        const created = await json(await fetchImpl(`${api}/customers`, {
          method: "POST",
          headers: headers(),
          body: JSON.stringify({ name: i.customer.name, cpfCnpj: i.customer.document, mobilePhone: i.customer.phone.replace(/^55/, ""), notificationDisabled: true }),
        }), "Asaas (criar cliente)");
        customerId = created?.id;
      }
      if (!customerId) throw new ProviderError("Asaas não devolveu o cliente");
      const due = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" }).format(i.expiresAt); // AAAA-MM-DD
      const charge = await json(await fetchImpl(`${api}/payments`, {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({
          customer: customerId,
          billingType: i.cardLink ? "UNDEFINED" : "PIX",
          value: i.amountCents / 100,
          dueDate: due,
          description: i.description.slice(0, 500),
          externalReference: i.reference,
        }),
      }), "Asaas (criar cobrança)");
      if (!charge?.id) throw new ProviderError("Asaas não devolveu a cobrança");
      const qr = await get(`/payments/${charge.id}/pixQrCode`, "Asaas (Pix)");
      return { externalId: charge.id, pixCode: qr?.payload ?? null, paymentUrl: i.cardLink ? charge.invoiceUrl ?? null : null };
    },
    async checkStatus(externalId) {
      const p = await get(`/payments/${encodeURIComponent(externalId)}`, "Asaas (consultar)");
      if (["RECEIVED", "CONFIRMED", "RECEIVED_IN_CASH"].includes(p?.status)) return "paid";
      if (p?.deleted) return "cancelled";
      if (p?.status === "REFUNDED") return "cancelled";
      return "pending";
    },
  };
}

// ---------- Efí (Pix com certificado) ----------

export function efi(cfg: { clientId?: string; clientSecret?: string; cert?: string; key?: string; pixKey?: string; sandbox: boolean }, fetchImpl: Fetch = fetch): Provider {
  const api = cfg.sandbox ? "https://pix-h.api.efipay.com.br" : "https://pix.api.efipay.com.br";
  const tls = { cert: cfg.cert, key: cfg.key };
  let token: { value: string; until: number } | null = null;
  const missing = [
    !cfg.clientId && "EFI_CLIENT_ID", !cfg.clientSecret && "EFI_CLIENT_SECRET",
    !(cfg.cert && cfg.key) && "EFI_CERT_PATH (certificado .pem)", !cfg.pixKey && "EFI_PIX_KEY",
  ].filter(Boolean) as string[];

  async function auth() {
    if (token && token.until > Date.now()) return token.value;
    const basic = Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`).toString("base64");
    const r = await json(await fetchImpl(`${api}/oauth/token`, {
      method: "POST",
      headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/json" },
      body: JSON.stringify({ grant_type: "client_credentials" }),
      tls,
    }), "Efí (autenticar)");
    token = { value: r.access_token, until: Date.now() + (Number(r.expires_in ?? 3600) - 60) * 1000 };
    return token.value;
  }
  const call = async (method: string, path: string, what: string, body?: unknown) =>
    json(await fetchImpl(`${api}${path}`, {
      method,
      headers: { Authorization: `Bearer ${await auth()}`, "Content-Type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
      tls,
    }), what);

  return {
    id: "efi",
    label: `Efí${cfg.sandbox ? " (homologação)" : ""} (Pix, confirmação automática)`,
    automatic: true,
    needsDocument: false,
    missing: missing.map((m) => `${m} no .env`),
    async createCharge(i) {
      if (missing.length) throw new ProviderError(`Efí sem configuração: ${missing.join(", ")}`);
      const seconds = Math.max(300, Math.round((i.expiresAt.getTime() - Date.now()) / 1000));
      const cob = await call("POST", "/v2/cob", "Efí (criar Pix)", {
        calendario: { expiracao: seconds },
        valor: { original: reais(i.amountCents) },
        chave: cfg.pixKey,
        solicitacaoPagador: i.description.slice(0, 140),
      });
      if (!cob?.txid || !cob?.pixCopiaECola) throw new ProviderError("Efí não devolveu o Pix copia e cola");
      return { externalId: cob.txid, pixCode: cob.pixCopiaECola, paymentUrl: null };
    },
    async checkStatus(txid) {
      const cob = await call("GET", `/v2/cob/${encodeURIComponent(txid)}`, "Efí (consultar)");
      if (cob?.status === "CONCLUIDA") return "paid";
      if (typeof cob?.status === "string" && cob.status.startsWith("REMOVIDA")) return "cancelled";
      return "pending";
    },
  };
}
