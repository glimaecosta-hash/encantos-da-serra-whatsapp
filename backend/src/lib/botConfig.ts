import { normalize } from "./text";

// Configuração do robô editada pelos donos no painel (Central do Robô).
// Existe um rascunho (testado no Simulador) e uma versão publicada (usada com os clientes).

export type Tone = "acolhedor" | "formal" | "descontraido";

export type Faq = { id: string; question: string; answer: string; keywords: string[] };

export type ProductKnowledge = { fabrication: string; pairing: string; storage: string; notes: string };

export type BotConfig = {
  persona: { name: string; tone: Tone; greeting: string; emojis: boolean };
  storeInfo: string;
  faqs: Faq[];
  products: Record<string, ProductKnowledge>; // por SKU
  rules: {
    maxDiscountPct: number;      // desconto que a IA pode dar sem chamar a equipe (0 = nenhum)
    minOrderCents: number;       // pedido mínimo (0 = sem mínimo)
    upsell: boolean;             // oferecer complemento
    freeShippingNudge: boolean;  // avisar quanto falta para o frete grátis
    handoffKeywords: string[];   // palavras que levam direto a uma pessoa
    extraInstructions: string;   // orientações livres para a IA
  };
};

export const DEFAULT_STORE_INFO = `- Encantos da Serra: laticínios artesanais da serra mineira (queijos, doce de leite, manteiga), de pequenos produtores parceiros.
- Entrega refrigerada: embalagem térmica entre 2 e 8 °C, da coleta até a porta. Cada região tem dia de rota e frete próprios; acima de um valor por região o frete é grátis.
- Cada atualização do pedido (pagamento, separação, saída para entrega, entrega) é avisada neste mesmo número.
- Compra por caixa (preço de atacado por faixa) é para empresas: empórios, restaurantes, mercados. Quem cuida é o comercial.`;

export const DEFAULT_BOT_CONFIG: BotConfig = {
  persona: {
    name: "atendente virtual",
    tone: "acolhedor",
    greeting: "Olá{, nome}! 👋 Aqui é o atendimento da *Encantos da Serra* — laticínios artesanais da serra mineira.",
    emojis: true,
  },
  storeInfo: DEFAULT_STORE_INFO,
  faqs: [],
  products: {},
  rules: { maxDiscountPct: 0, minOrderCents: 0, upsell: true, freeShippingNudge: true, handoffKeywords: [], extraInstructions: "" },
};

// Completa campos que faltarem (configurações salvas antes de um campo novo existir).
export function withDefaults(c: Partial<BotConfig> | null | undefined): BotConfig {
  const d = DEFAULT_BOT_CONFIG;
  return {
    persona: { ...d.persona, ...(c?.persona ?? {}) },
    storeInfo: c?.storeInfo ?? d.storeInfo,
    faqs: c?.faqs ?? [],
    products: c?.products ?? {},
    rules: { ...d.rules, ...(c?.rules ?? {}) },
  };
}

// "Olá{, nome}!" → "Olá, Mariana!" ou "Olá!" sem nome.
export function renderGreeting(template: string, firstName: string) {
  return template.replace(/\{([^{}]*)nome\}/g, (_, prefix: string) => (firstName ? `${prefix}${firstName}` : "")).trim();
}

export const TONE_TEXT: Record<Tone, string> = {
  acolhedor: "acolhedora, calorosa e simples, com a hospitalidade de um empório mineiro",
  formal: "cordial e profissional, com linguagem cuidada e sem gírias",
  descontraido: "leve e bem-humorada, próxima como uma amiga que entende de queijo, sem exagerar",
};

// Pergunta frequente que responde a mensagem: alguma palavra-chave aparece no texto do cliente.
export function matchFaq(text: string, faqs: Faq[]): Faq | undefined {
  const t = ` ${normalize(text).replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ")} `;
  let best: { faq: Faq; score: number } | undefined;
  for (const f of faqs) {
    const score = f.keywords.reduce((acc, k) => {
      const kw = normalize(k).replace(/[^a-z0-9 ]/g, " ").trim();
      return kw && t.includes(` ${kw} `) ? acc + kw.length : acc;
    }, 0);
    if (score > 0 && (!best || score > best.score)) best = { faq: f, score };
  }
  return best?.faq;
}

export function containsKeyword(text: string, keywords: string[]) {
  const t = ` ${normalize(text).replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ")} `;
  return keywords.some((k) => {
    const kw = normalize(k).replace(/[^a-z0-9 ]/g, " ").trim();
    return kw.length > 1 && t.includes(` ${kw} `);
  });
}
