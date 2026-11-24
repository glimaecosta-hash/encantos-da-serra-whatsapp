import { Fragment, type ReactNode } from "react";

// Tipos e textos compartilhados do Atendimento (WhatsApp) e do Simulador.

export type Stage = "bot" | "waiting" | "negotiating" | "awaiting_customer" | "won" | "lost";
export type Topic = "compra" | "atacado" | "pedido" | "duvida" | "reclamacao";

export type ConversationItem = {
  id: number;
  stage: Stage;
  mode: "bot" | "human";
  topic: Topic;
  unreadCount: number;
  lastMessageAt: string;
  waitingSince: string | null;
  createdAt: string;
  closedAt: string | null;
  contactId: number;
  phone: string;
  phoneLabel: string;
  name: string | null;
  businessName: string | null;
  assignedName: string | null;
  assignedTo: number | null;
  orderCode: string | null;
  orderTotalCents: number | null;
  lastMessage: { author: string; body: string; at: string } | null;
};

export type CartLine = { productId: number; sku: string; name: string; unitLabel: string; priceCents: number; quantity: number };

export type ConversationDetail = {
  conversation: ConversationItem & {
    botState: string;
    botData: { cart?: CartLine[]; cep?: string; address?: Record<string, string> };
    lostReason: string | null;
    contactNotes: string | null;
    orderId: number | null;
  };
  messages: { id: number; author: "customer" | "bot" | "agent" | "note" | "system"; body: string; options: { key: string; label: string }[] | null; createdAt: string; agentName: string | null }[];
  orders: { code: string; status: string; totalCents: number; discountCents: number; source: string; createdAt: string; scheduledDelivery: string | null }[];
  history: { id: number; stage: Stage; topic: Topic; createdAt: string; closedAt: string | null }[];
};

export type Counts = Record<"open" | "attention" | "mine" | "bot" | "waiting" | "negotiating" | "awaiting_customer" | "closed", number>;

// Etapas na linguagem de quem atende: o que é, e o que fazer.
export const STAGE_INFO: Record<Stage, { label: string; short: string; help: string }> = {
  bot: { label: "Com o chatbot", short: "Chatbot", help: "O robô está atendendo sozinho. Não precisa fazer nada." },
  waiting: { label: "Aguardando atendente", short: "Na fila", help: "O cliente pediu uma pessoa ou o caso precisa de negociação. Assuma e responda." },
  negotiating: { label: "Em atendimento", short: "Em atendimento", help: "Um responsável está conduzindo. O cliente respondeu e espera retorno." },
  awaiting_customer: { label: "Aguardando cliente", short: "Esperando cliente", help: "Você já respondeu. A conversa volta para 'Em atendimento' quando o cliente escrever." },
  won: { label: "Fechada com pedido", short: "Pedido feito", help: "Virou pedido. Acompanhe pelo menu Pedidos." },
  lost: { label: "Encerrada sem pedido", short: "Sem pedido", help: "Encerrada com motivo registrado." },
};

export const TOPIC_LABEL: Record<Topic, string> = {
  compra: "Compra",
  atacado: "Atacado",
  pedido: "Pedido",
  duvida: "Dúvida",
  reclamacao: "Reclamação",
};

export const LOST_REASONS = ["Preço", "Fora da área de entrega", "Sem estoque do produto", "Cliente parou de responder", "Só queria informação", "Outro"];

// Respostas prontas para agilizar o atendimento ({nome} vira o primeiro nome do cliente).
export const QUICK_REPLIES = [
  { label: "Saudação", text: "Oi, {nome}! Aqui é da Encantos da Serra. Vou cuidar do seu atendimento. 😊" },
  { label: "Pagamento Pix", text: "Para confirmar, o pagamento pode ser feito por Pix (chave CNPJ). Assim que cair, seu pedido entra na separação." },
  { label: "Pagamento confirmado", text: "Pagamento confirmado! ✅ Seu pedido já está na fila de separação na câmara fria." },
  { label: "Prazo de entrega", text: "Entregamos com rota refrigerada (2 a 8 °C). Me passa seu CEP que confirmo o próximo dia de rota." },
  { label: "Proposta atacado", text: "Para empresas trabalhamos com preço por caixa e faixas de volume. Vou montar uma proposta e te mando por aqui." },
  { label: "Encerrar", text: "Obrigado pelo contato, {nome}! Qualquer coisa é só chamar por aqui. 🧀" },
];

// Formatação do WhatsApp: *negrito*, _itálico_, quebras de linha.
export function WaText({ text }: { text: string }) {
  const lines = text.split("\n");
  return (
    <>
      {lines.map((line, i) => (
        <Fragment key={i}>
          {formatLine(line)}
          {i < lines.length - 1 && <br />}
        </Fragment>
      ))}
    </>
  );
}

function formatLine(line: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /\*([^*\n]+)\*|_([^_\n]+)_/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line))) {
    if (m.index > last) out.push(line.slice(last, m.index));
    out.push(m[1] ? <b key={m.index}>{m[1]}</b> : <i key={m.index}>{m[2]}</i>);
    last = m.index + m[0].length;
  }
  if (last < line.length) out.push(line.slice(last));
  return out;
}

export const firstName = (name: string | null | undefined) => name?.trim().split(/\s+/)[0] ?? "";

export const initials = (name: string | null | undefined) =>
  (name ?? "?").replace(/[^\p{L}\s]/gu, "").trim().split(/\s+/).slice(0, 2).map((p) => p[0]?.toUpperCase()).join("") || "?";

export const clock = (iso: string) => new Date(iso).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });

export function dayHeader(iso: string) {
  const d = new Date(iso);
  const today = new Date();
  const yesterday = new Date(Date.now() - 86_400_000);
  if (d.toDateString() === today.toDateString()) return "Hoje";
  if (d.toDateString() === yesterday.toDateString()) return "Ontem";
  return d.toLocaleDateString("pt-BR", { day: "2-digit", month: "long" });
}

// "há 5 min" para o tempo de espera na fila.
export function waited(iso: string) {
  const min = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  if (h < 48) return `${h} h ${min % 60 ? `${min % 60} min` : ""}`.trim();
  return `${Math.round(h / 24)} dias`;
}
