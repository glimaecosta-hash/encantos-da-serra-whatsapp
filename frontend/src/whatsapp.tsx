import { useEffect, useState } from "react";
import { api } from "./api";
import { Icon } from "./icons";
import { useLocation } from "./router";

// Compra pelo WhatsApp: o site vira vitrine e cada botão abre a conversa com o chatbot já com o produto.
// O número e o modo de venda vêm do painel (Atendimento → Configurações).

export type WhatsAppInfo = { number: string; displayNumber: string; hours: string; shopMode: "whatsapp" | "cart" };

const FALLBACK: WhatsAppInfo = { number: "", displayNumber: "", hours: "", shopMode: "whatsapp" };
let cache: WhatsAppInfo | null = null;
let pending: Promise<WhatsAppInfo> | null = null;

function load(): Promise<WhatsAppInfo> {
  if (cache) return Promise.resolve(cache);
  pending ??= api<WhatsAppInfo>("/whatsapp/info").then((i) => (cache = i)).catch(() => FALLBACK);
  return pending;
}

export function useWhatsApp() {
  const [info, setInfo] = useState<WhatsAppInfo>(cache ?? FALLBACK);
  useEffect(() => { load().then(setInfo); }, []);
  return {
    ...info,
    // Com o modo "whatsapp" o carrinho do site some e os botões passam a abrir o WhatsApp.
    viaWhatsApp: info.shopMode !== "cart",
    link: (text: string) => `https://wa.me/${info.number}?text=${encodeURIComponent(text)}`,
  };
}

// Mensagens prontas: o código do produto (cód.) faz o chatbot abrir o item direto.
export const productMessage = (p: { name: string; sku: string }, qty?: number, unit?: string) =>
  `Olá! Quero pedir ${qty && qty > 1 ? `${qty} ${unit ?? "un"} de ` : ""}${p.name} (cód. ${p.sku})`;

export const wholesaleMessage = (lines: { name: string; boxes: number }[]) =>
  `Olá! Tenho interesse em compra para empresa (atacado):\n${lines.map((l) => `• ${l.boxes} cx ${l.name}`).join("\n")}`;

export function WhatsAppGlyph({ size = 20 }: { size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="currentColor" aria-hidden="true">
      <path d="M12 2.2A9.8 9.8 0 0 0 3.6 17l-1.4 4.8 5-1.3A9.8 9.8 0 1 0 12 2.2Zm0 17.8a8 8 0 0 1-4.1-1.1l-.3-.2-3 .8.8-2.9-.2-.3A8 8 0 1 1 12 20Zm4.4-6c-.2-.1-1.4-.7-1.7-.8-.2-.1-.4-.1-.5.1l-.8 1c-.1.2-.3.2-.5.1a6.6 6.6 0 0 1-3.3-2.9c-.2-.4.2-.4.7-1.3.1-.2 0-.3 0-.4l-.8-1.8c-.2-.5-.4-.4-.5-.4h-.5a.9.9 0 0 0-.6.3 2.7 2.7 0 0 0-.9 2c0 1.2.9 2.3 1 2.5.1.2 1.7 2.6 4.2 3.7 1.6.7 2.2.7 3 .6.5-.1 1.4-.6 1.6-1.1.2-.6.2-1 .1-1.1l-.5-.4Z" />
    </svg>
  );
}

// Botão verde padrão. `href` já vem com a mensagem pronta.
export function WhatsAppButton({ href, children, className = "", disabled }: { href: string; children: React.ReactNode; className?: string; disabled?: boolean }) {
  if (disabled) return <button className={`btn btn-wa ${className}`} disabled>{children}</button>;
  return (
    <a className={`btn btn-wa ${className}`} href={href} target="_blank" rel="noreferrer">
      <WhatsAppGlyph size={18} />{children}
    </a>
  );
}

// Botão flutuante em todas as páginas da loja.
export function WhatsAppFloat() {
  const wa = useWhatsApp();
  const { pathname } = useLocation();
  if (!wa.number || pathname.startsWith("/admin")) return null;
  return (
    <a className="wa-float" href={wa.link("Olá! Vim pelo site da Encantos da Serra.")} target="_blank" rel="noreferrer" aria-label="Fale conosco pelo WhatsApp">
      <WhatsAppGlyph size={28} />
      <span className="wa-float-label">Pedir pelo WhatsApp</span>
    </a>
  );
}

// "Como comprar": três passos, para o cliente entender que a compra é pela conversa.
export function HowToBuy({ compact }: { compact?: boolean }) {
  const wa = useWhatsApp();
  const steps = [
    { icon: "search" as const, title: "Escolha no site", text: "Veja fotos, origem, cura e preço de cada produto." },
    { icon: "chat" as const, title: "Peça pelo WhatsApp", text: "O botão abre a conversa já com o produto. Nosso atendente virtual monta o pedido e calcula o frete pelo CEP." },
    { icon: "snowflake" as const, title: "Receba refrigerado", text: "Confirmamos o pagamento por lá e você acompanha cada etapa da entrega no mesmo número." },
  ];
  return (
    <section className={`how-buy ${compact ? "compact" : ""}`} aria-labelledby="how-buy-title">
      <div className="how-buy-head">
        <span className="eyebrow">Como comprar</span>
        <h2 id="how-buy-title">Seu pedido em uma conversa</h2>
        {!compact && <p>Sem cadastro e sem formulário: tudo pelo WhatsApp, com uma pessoa da equipe sempre que você precisar.</p>}
      </div>
      <ol className="how-buy-steps">
        {steps.map((s, i) => (
          <li key={s.title}>
            <span className="how-buy-n">{i + 1}</span>
            <Icon name={s.icon} />
            <b>{s.title}</b>
            <p>{s.text}</p>
          </li>
        ))}
      </ol>
      {wa.number && (
        <div className="how-buy-cta">
          <WhatsAppButton href={wa.link("Olá! Quero fazer um pedido.")} className="btn-lg">Começar pelo WhatsApp</WhatsAppButton>
          <small>{wa.displayNumber}{wa.hours ? ` · Atendimento humano: ${wa.hours}` : ""}</small>
        </div>
      )}
    </section>
  );
}
