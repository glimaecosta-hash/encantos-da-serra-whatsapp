import { useEffect, useRef, useState } from "react";
import { api, ApiError } from "../api";
import { Icon } from "../icons";
import { Link, useLocation } from "../router";
import { useApi, useStore } from "../store";
import { clock, initials, WaText } from "./attendance";

// Painel → Simulador: o responsável testa o chatbot como se fosse o cliente no WhatsApp.
// Útil para treinar a equipe e demonstrar o atendimento antes de ligar o número oficial.

type SimMessage = { id: number; author: "customer" | "bot" | "agent"; body: string; options: { key: string; label: string }[] | null; createdAt: string };
type SimContact = { phone: string; name: string | null; phoneLabel: string };

const SUGGESTIONS = ["oi", "menu", "atendente", "carrinho", "Quero pedir Queijo Canastra Meia Cura (cód. CAN-MC600)", "o queijo chegou quente"];

export function SimulatorPage() {
  const { toast } = useStore();
  const { search } = useLocation();
  // Testar o rascunho da Central do Robô (só aqui no Simulador; clientes usam a versão publicada).
  const [useDraft, setUseDraft] = useState(() => search.get("rascunho") === "1");
  const contacts = useApi<{ contacts: SimContact[] }>("/admin/atendimento/simulator/contacts");
  const [phone, setPhone] = useState("31987654321");
  const [name, setName] = useState("Cliente Teste");
  const [messages, setMessages] = useState<SimMessage[]>([]);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);

  const load = async (p = phone) => {
    if (p.replace(/\D/g, "").length < 10) return;
    try {
      const r = await api<{ messages: SimMessage[] }>(`/admin/atendimento/simulator/thread?phone=${encodeURIComponent(p)}`);
      setMessages((old) => (old.length === r.messages.length && old.at(-1)?.id === r.messages.at(-1)?.id ? old : r.messages));
    } catch { /* telefone incompleto */ }
  };

  // Busca respostas do responsável (enviadas pelo painel) a cada 3 s.
  useEffect(() => {
    load();
    const t = setInterval(() => load(), 3000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phone]);

  useEffect(() => {
    requestAnimationFrame(() => scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: "smooth" }));
  }, [messages.length]);

  const send = async (body = text) => {
    const msg = body.trim();
    if (!msg) return;
    setSending(true);
    setText("");
    setMessages((m) => [...m, { id: -Date.now(), author: "customer", body: msg, options: null, createdAt: new Date().toISOString() }]);
    try {
      const r = await api<{ messages: SimMessage[] }>("/admin/atendimento/simulator/messages", { body: { phone, name: name.trim() || undefined, text: msg, useDraft } });
      setMessages(r.messages);
      contacts.reload();
    } catch (e) {
      toast({ message: e instanceof ApiError ? e.message : "Falha ao enviar", kind: "error" });
    } finally { setSending(false); }
  };

  const lastOptions = [...messages].reverse().find((m) => m.author !== "customer")?.options ?? null;
  const lastIsBot = messages.at(-1)?.author === "bot";

  return (
    <div className="sim">
      <div className="adm-head">
        <div>
          <h1>Simulador do WhatsApp</h1>
          <p>Converse com o chatbot como se fosse um cliente. Tudo o que acontece aqui aparece em <Link to="/admin/atendimento" style={{ textDecoration: "underline" }}>Atendimento</Link> e os pedidos criados entram em Pedidos e no estoque.</p>
        </div>
      </div>

      <div className="sim-grid">
        <div className="sim-phone" aria-label="Tela do WhatsApp simulada">
          <div className="sim-top">
            <span className="sim-avatar"><Icon name="mountain" className="icon-sm" /></span>
            <div><b>Encantos da Serra</b><small>{sending ? "digitando…" : "online"}</small></div>
          </div>
          <div className="sim-thread" ref={scroller}>
            {messages.length === 0 && <div className="sim-hint">Mande um “oi” para começar 👋</div>}
            {messages.map((m) => (
              <div key={m.id} className="sim-msg" data-author={m.author}>
                <div className="sim-bubble">
                  {m.author === "agent" && <span className="sim-agent">Atendente</span>}
                  <WaText text={m.body} />
                  <time>{clock(m.createdAt)}{m.author === "customer" && <span className="sim-ticks"> ✓✓</span>}</time>
                </div>
              </div>
            ))}
            {sending && <div className="sim-msg" data-author="bot"><div className="sim-bubble sim-typing"><i /><i /><i /></div></div>}
          </div>
          {lastIsBot && lastOptions && lastOptions.length > 0 && (
            <div className="sim-options" aria-label="Respostas rápidas">
              {lastOptions.map((o) => <button key={o.key} onClick={() => send(o.key)} disabled={sending}><b>{o.key}</b> {o.label}</button>)}
            </div>
          )}
          <form className="sim-input" onSubmit={(e) => { e.preventDefault(); send(); }}>
            <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Mensagem" aria-label="Mensagem do cliente" disabled={sending} />
            <button type="submit" disabled={sending || !text.trim()} aria-label="Enviar"><Icon name="arrowRight" className="icon-sm" /></button>
          </form>
        </div>

        <div className="sim-side">
          <section className="adm-card sim-card sim-version" data-draft={useDraft}>
            <h2>Versão do robô</h2>
            <div className="adm-seg" role="group" aria-label="Versão do robô no teste">
              <button aria-pressed={!useDraft} onClick={() => setUseDraft(false)}>Publicada (a dos clientes)</button>
              <button aria-pressed={useDraft} onClick={() => setUseDraft(true)}>Rascunho</button>
            </div>
            <small className="adm-muted">{useDraft ? "Você está testando o rascunho da " : "Para testar mudanças antes de publicar, escolha Rascunho. Edite em "}<Link to="/admin/robo" style={{ textDecoration: "underline" }}>Central do Robô</Link>.</small>
          </section>

          <section className="adm-card sim-card">
            <h2>Quem está escrevendo</h2>
            <div className="att-row2">
              <label className="field"><span>Telefone (DDD + número)</span><input className="input" value={phone} onChange={(e) => setPhone(e.target.value)} inputMode="tel" /></label>
              <label className="field"><span>Nome no WhatsApp</span><input className="input" value={name} onChange={(e) => setName(e.target.value)} /></label>
            </div>
            <button className="btn btn-outline btn-sm" onClick={() => { const n = `319${String(Math.floor(Math.random() * 1e8)).padStart(8, "0")}`; setPhone(n); setName("Novo Cliente"); setMessages([]); }}>
              <Icon name="plus" className="icon-sm" />Novo cliente de teste
            </button>
            {(contacts.data?.contacts.length ?? 0) > 0 && (
              <>
                <h3>Conversas recentes</h3>
                <ul className="sim-contacts">
                  {contacts.data!.contacts.map((c) => (
                    <li key={c.phone}>
                      <button aria-current={c.phone.endsWith(phone.replace(/\D/g, "")) || undefined} onClick={() => { setPhone(c.phone.replace(/^55/, "")); setName(c.name ?? ""); setMessages([]); }}>
                        <span className="att-avatar">{initials(c.name)}</span>
                        <span><b>{c.name ?? c.phoneLabel}</b><small>{c.phoneLabel}</small></span>
                      </button>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </section>

          <section className="adm-card sim-card">
            <h2>Experimente</h2>
            <div className="sim-suggest">
              {SUGGESTIONS.map((s) => <button key={s} className="chip" onClick={() => send(s)} disabled={sending}>{s}</button>)}
            </div>
            <ul className="sim-tips">
              <li><b>Compra completa:</b> oi → 1 → escolha linha e produto → quantidade → 2 (finalizar) → CEP (ex.: 30130000) → endereço → 1 (confirmar).</li>
              <li><b>Atacado:</b> oi → 3 → descreva o que precisa. A conversa vai para a fila do responsável.</li>
              <li><b>Responder como equipe:</b> abra a conversa em Atendimento, escreva lá e a resposta aparece aqui em alguns segundos.</li>
              <li>Em qualquer momento: <b>menu</b>, <b>carrinho</b>, <b>atendente</b> ou <b>cancelar</b>.</li>
            </ul>
          </section>
        </div>
      </div>
    </div>
  );
}
