import { useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError } from "../api";
import { brl, cepMask, shortDate, STATUS_LABEL } from "../format";
import { Icon } from "../icons";
import { Link, navigate, useLocation } from "../router";
import { useApi, useDebounced, useStore } from "../store";
import {
  clock, dayHeader, firstName, initials, LOST_REASONS, QUICK_REPLIES, STAGE_INFO, TOPIC_LABEL, WaText, waited,
  type ConversationDetail, type ConversationItem, type Counts, type Stage,
} from "./attendance";
import { Dialog } from "./Dialog";
import { fromCents, toCents, type AdminProduct } from "./types";

// Painel → Atendimento: fila das conversas do WhatsApp, conversa aberta e ficha do cliente.

const VIEWS: { id: string; label: string; count?: keyof Counts; tone?: "alert" }[] = [
  { id: "attention", label: "Precisam de você", count: "attention", tone: "alert" },
  { id: "mine", label: "Minhas", count: "mine" },
  { id: "open", label: "Todas abertas", count: "open" },
  { id: "bot", label: "Com o chatbot", count: "bot" },
  { id: "awaiting_customer", label: "Esperando cliente", count: "awaiting_customer" },
  { id: "closed", label: "Encerradas", count: "closed" },
];

type ListResponse = { conversations: ConversationItem[]; counts: Counts; transport: string };

function useSelectedId(): number | null {
  const { search } = useLocation();
  const id = Number(search.get("c"));
  return Number.isInteger(id) && id > 0 ? id : null;
}

const select = (id: number | null) => navigate(id ? `/admin/atendimento?c=${id}` : "/admin/atendimento", { scroll: false, replace: true });

export function AttendancePage() {
  const [view, setView] = useState("open");
  const [q, setQ] = useState("");
  const term = useDebounced(q.trim(), 300);
  const selectedId = useSelectedId();
  const list = useApi<ListResponse>(`/admin/atendimento?view=${view}${term ? `&q=${encodeURIComponent(term)}` : ""}`);
  const [showGuide, setShowGuide] = useState(false);
  const [showSettings, setShowSettings] = useState(false);

  // "Tempo real" simples: a fila se atualiza sozinha a cada 8 s.
  useEffect(() => {
    const t = setInterval(() => list.reload(), 8000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, term]);

  const counts = list.data?.counts;
  const conversations = list.data?.conversations ?? [];

  return (
    <div className="att" data-selected={!!selectedId}>
      <div className="adm-head">
        <div>
          <h1>Atendimento</h1>
          <p>Conversas do WhatsApp. O chatbot atende primeiro; quando o cliente pede uma pessoa, quer negociar ou fecha um pedido, a conversa entra em <b>Precisam de você</b>.</p>
        </div>
        <div className="att-head-actions">
          {list.data?.transport === "simulador" && (
            <Link to="/admin/simulador" className="att-sim-pill" title="As mensagens não saem para o WhatsApp real. Teste em Simulador.">
              <Icon name="phone" className="icon-sm" />Modo simulador
            </Link>
          )}
          <button className="btn btn-outline btn-sm" onClick={() => setShowGuide(true)}><Icon name="sparkle" className="icon-sm" />Como funciona</button>
          <button className="btn btn-outline btn-sm" onClick={() => setShowSettings(true)}><Icon name="sliders" className="icon-sm" />Configurações</button>
        </div>
      </div>

      <div className="att-funnel" aria-label="Etapas do atendimento">
        {(["bot", "waiting", "negotiating", "awaiting_customer"] as Stage[]).map((s, i) => (
          <button key={s} className="att-funnel-step" data-stage={s} aria-pressed={view === s} onClick={() => setView(view === s ? "open" : s)} title={STAGE_INFO[s].help}>
            <span className="att-funnel-n">{counts?.[s as keyof Counts] ?? "–"}</span>
            <span className="att-funnel-label">{STAGE_INFO[s].label}</span>
            {i < 3 && <Icon name="arrowRight" className="icon-sm att-funnel-arrow" />}
          </button>
        ))}
      </div>

      <div className="att-grid" data-has-selection={!!selectedId}>
        <aside className="att-list adm-card" aria-label="Conversas">
          <div className="att-list-head">
            <label className="adm-search" style={{ minWidth: 0 }}>
              <Icon name="search" className="icon-sm" />
              <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Nome, telefone, empresa ou pedido" aria-label="Buscar conversas" />
            </label>
            <div className="att-views" role="tablist" aria-label="Filtrar conversas">
              {VIEWS.map((v) => (
                <button key={v.id} role="tab" aria-selected={view === v.id} className="chip" aria-pressed={view === v.id} onClick={() => setView(v.id)}>
                  {v.label}
                  {v.count && counts && counts[v.count] > 0 && <span className={v.tone ? "adm-count" : "att-count-muted"}>{counts[v.count]}</span>}
                </button>
              ))}
            </div>
          </div>
          <ul className="att-items">
            {list.loading && !list.data && <li><div className="skeleton" style={{ height: 240, margin: 12 }} /></li>}
            {list.data && conversations.length === 0 && (
              <li className="att-empty">
                {view === "attention" ? <><Icon name="checkCircle" />Tudo em dia! Nenhum cliente esperando resposta.</> : "Nenhuma conversa aqui."}
              </li>
            )}
            {conversations.map((c) => <ConversationRow key={c.id} c={c} active={c.id === selectedId} />)}
          </ul>
        </aside>

        {selectedId
          ? <ConversationPane key={selectedId} id={selectedId} onChanged={list.reload} />
          : (
            <section className="att-placeholder adm-card">
              <Icon name="chat" size={40} />
              <h2>Escolha uma conversa</h2>
              <p>As conversas com <span className="att-dot" data-stage="waiting" /> laranja estão na fila esperando um responsável.</p>
              <Link to="/admin/simulador" className="btn btn-outline btn-sm"><Icon name="phone" className="icon-sm" />Testar o chatbot no simulador</Link>
            </section>
          )}
      </div>

      <GuideDialog open={showGuide} onClose={() => setShowGuide(false)} />
      <SettingsDialog open={showSettings} onClose={() => setShowSettings(false)} />
    </div>
  );
}

function ConversationRow({ c, active }: { c: ConversationItem; active: boolean }) {
  const last = c.lastMessage;
  const who = last?.author === "customer" ? "" : last?.author === "bot" ? "🤖 " : last?.author === "agent" ? "Você: " : "";
  return (
    <li>
      <button className="att-item" aria-current={active || undefined} data-unread={c.unreadCount > 0} onClick={() => select(c.id)}>
        <span className="att-avatar" data-stage={c.stage}>{initials(c.name)}</span>
        <span className="att-item-main">
          <span className="att-item-top">
            <b>{c.name ?? c.phoneLabel}</b>
            <small>{last ? clock(last.at) : ""}</small>
          </span>
          {c.businessName && <small className="att-biz">{c.businessName}</small>}
          <span className="att-item-last">{last?.author === "system" ? <i>{last.body}</i> : <>{who}{last?.body.replace(/[*_]/g, "")}</>}</span>
          <span className="att-item-tags">
            <span className="att-stage" data-stage={c.stage}>{STAGE_INFO[c.stage].short}</span>
            <span className="att-topic" data-topic={c.topic}>{TOPIC_LABEL[c.topic]}</span>
            {c.stage === "waiting" && c.waitingSince && <span className="att-wait"><Icon name="clock" className="icon-sm" />{waited(c.waitingSince)}</span>}
            {c.orderCode && <span className="att-order-tag">{c.orderCode}</span>}
            {c.unreadCount > 0 && <span className="adm-count" aria-label={`${c.unreadCount} não lidas`}>{c.unreadCount}</span>}
          </span>
        </span>
      </button>
    </li>
  );
}

// ---------------- Conversa aberta ----------------

function ConversationPane({ id, onChanged }: { id: number; onChanged: () => void }) {
  const { toast, user } = useStore();
  const { data, setData, reload } = useApi<ConversationDetail>(`/admin/atendimento/${id}`);
  const [mode, setMode] = useState<"reply" | "note">("reply");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [orderOpen, setOrderOpen] = useState(false);
  const [lostOpen, setLostOpen] = useState(false);
  const [sideOpen, setSideOpen] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const lastCount = useRef(0);

  useEffect(() => {
    const t = setInterval(() => reload(), 5000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  useEffect(() => {
    const n = data?.messages.length ?? 0;
    if (n !== lastCount.current) {
      lastCount.current = n;
      requestAnimationFrame(() => scroller.current?.scrollTo({ top: scroller.current.scrollHeight }));
    }
  }, [data?.messages.length]);

  const run = async (path: string, body?: unknown, ok?: string) => {
    setBusy(true);
    try {
      const res = await api<ConversationDetail>(`/admin/atendimento/${id}${path}`, { method: body === undefined ? "POST" : undefined, body });
      setData(res);
      onChanged();
      if (ok) toast({ message: ok });
      return true;
    } catch (e) {
      toast({ message: e instanceof ApiError ? e.message : "Não foi possível concluir", kind: "error" });
      return false;
    } finally { setBusy(false); }
  };

  const patch = async (path: string, body: unknown, ok?: string) => {
    setBusy(true);
    try {
      setData(await api<ConversationDetail>(`/admin/atendimento/${id}${path}`, { method: "PATCH", body }));
      onChanged();
      if (ok) toast({ message: ok });
      return true;
    } catch (e) {
      toast({ message: e instanceof ApiError ? e.message : "Não foi possível concluir", kind: "error" });
      return false;
    } finally { setBusy(false); }
  };

  if (!data) return <section className="att-chat adm-card"><div className="skeleton" style={{ height: "100%", minHeight: 400 }} /></section>;

  const c = data.conversation;
  const closed = !!c.closedAt;
  const name = c.name ?? c.phoneLabel;

  const send = async () => {
    const body = text.trim();
    if (!body) return;
    const ok = await run(mode === "note" ? "/notes" : "/messages", { body });
    if (ok) setText("");
  };

  const groups: { day: string; items: ConversationDetail["messages"] }[] = [];
  for (const m of data.messages) {
    const day = dayHeader(m.createdAt);
    if (groups.at(-1)?.day !== day) groups.push({ day, items: [] });
    groups.at(-1)!.items.push(m);
  }

  return (
    <>
      <section className="att-chat adm-card" aria-label={`Conversa com ${name}`}>
        <header className="att-chat-head">
          <button className="adm-icon-btn att-back" onClick={() => select(null)} aria-label="Voltar para a lista"><Icon name="arrowRight" className="icon-sm" style={{ transform: "rotate(180deg)" }} /></button>
          <span className="att-avatar lg" data-stage={c.stage}>{initials(c.name)}</span>
          <div className="att-chat-who">
            <b>{name}</b>
            <small>{c.phoneLabel}{c.businessName ? ` · ${c.businessName}` : ""}</small>
          </div>
          <div className="att-chat-status">
            <span className="att-stage lg" data-stage={c.stage}>{STAGE_INFO[c.stage].label}</span>
            <small className="adm-muted">{c.mode === "bot" ? "🤖 Chatbot respondendo" : c.assignedName ? `Com ${c.assignedName}` : "Sem responsável"}</small>
          </div>
          <button className="btn btn-outline btn-sm att-side-toggle" onClick={() => setSideOpen(true)}><Icon name="user" className="icon-sm" /><span className="att-hide-sm">Cliente</span></button>
        </header>

        {!closed && (
          <div className="att-actions">
            {(c.mode === "bot" || c.assignedTo !== user?.id) && (
              <button className="btn btn-primary btn-sm" disabled={busy} onClick={() => run("/assume", undefined, "Conversa assumida. O chatbot fica em silêncio.")}>
                <Icon name="headset" className="icon-sm" />{c.mode === "bot" ? "Assumir conversa" : "Assumir para mim"}
              </button>
            )}
            {c.mode === "human" && (
              <button className="btn btn-outline btn-sm" disabled={busy} onClick={() => run("/release", undefined, "Conversa devolvida ao chatbot.")}>
                🤖 Devolver ao chatbot
              </button>
            )}
            <button className="btn btn-gold btn-sm" disabled={busy} onClick={() => setOrderOpen(true)}>
              <Icon name="receipt" className="icon-sm" />Fechar pedido
            </button>
            {c.orderId && c.stage !== "won" && (
              <button className="btn btn-outline btn-sm" disabled={busy} onClick={() => patch("/stage", { stage: "won" }, "Conversa encerrada com pedido.")}>
                <Icon name="checkCircle" className="icon-sm" />Concluir (pedido {c.orderCode})
              </button>
            )}
            <button className="btn btn-sm adm-btn-ghost-danger" disabled={busy} onClick={() => setLostOpen(true)}>Encerrar sem pedido</button>
          </div>
        )}
        {closed && (
          <div className="att-closed-bar">
            <Icon name={c.stage === "won" ? "checkCircle" : "x"} className="icon-sm" />
            {c.stage === "won" ? <>Conversa encerrada com o pedido <Link to={`/admin?q=${c.orderCode}`}><b>{c.orderCode}</b></Link>.</> : <>Encerrada sem pedido — {c.lostReason}.</>}
            <span className="adm-muted"> Se o cliente escrever de novo, abre uma nova conversa.</span>
          </div>
        )}

        <div className="att-thread" ref={scroller}>
          {groups.map((g) => (
            <div key={g.day}>
              <div className="att-day"><span>{g.day}</span></div>
              {g.items.map((m) => (
                m.author === "system"
                  ? <div key={m.id} className="att-sys"><span>{m.body}</span></div>
                  : (
                    <div key={m.id} className="att-msg" data-author={m.author}>
                      <div className="att-bubble">
                        {m.author !== "customer" && (
                          <span className="att-msg-who">{m.author === "bot" ? "🤖 Chatbot" : m.author === "note" ? `📝 Nota interna · ${m.agentName ?? ""}` : m.agentName ?? "Responsável"}</span>
                        )}
                        <WaText text={m.body} />
                        <time>{clock(m.createdAt)}</time>
                      </div>
                    </div>
                  )
              ))}
            </div>
          ))}
        </div>

        {!closed && (
          <div className="att-composer" data-mode={mode}>
            <div className="att-composer-tabs" role="tablist">
              <button role="tab" aria-selected={mode === "reply"} onClick={() => setMode("reply")}><Icon name="chat" className="icon-sm" />Responder ao cliente</button>
              <button role="tab" aria-selected={mode === "note"} onClick={() => setMode("note")}>📝 Nota interna</button>
              {mode === "reply" && c.mode === "bot" && <small className="adm-muted">Ao responder, você assume a conversa e o chatbot para.</small>}
              {mode === "note" && <small className="adm-muted">Só a equipe vê. O cliente não recebe.</small>}
            </div>
            {mode === "reply" && (
              <div className="att-quick">
                {QUICK_REPLIES.map((r) => (
                  <button key={r.label} className="att-quick-btn" onClick={() => setText(r.text.replace("{nome}", firstName(c.name) || ""))}>{r.label}</button>
                ))}
              </div>
            )}
            <div className="att-composer-row">
              <textarea
                className="input" rows={2} value={text} onChange={(e) => setText(e.target.value)}
                placeholder={mode === "note" ? "Anotação para a equipe (ex.: cliente prefere entrega de manhã)" : `Mensagem para ${firstName(c.name) || "o cliente"}… (Enter envia, Shift+Enter quebra linha)`}
                onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }}
                aria-label={mode === "note" ? "Nota interna" : "Mensagem"}
              />
              <button className="btn btn-primary att-send" disabled={busy || !text.trim()} onClick={send} aria-label="Enviar">
                <Icon name={busy ? "loader" : "arrowRight"} className={busy ? "icon spin" : "icon"} />
              </button>
            </div>
          </div>
        )}
      </section>

      <ClientPanel data={data} open={sideOpen} onClose={() => setSideOpen(false)} onSave={(body) => patch("/contact", body, "Ficha do cliente salva.")} onUseCart={() => setOrderOpen(true)} />

      <OrderDialog open={orderOpen} onClose={() => setOrderOpen(false)} detail={data} onDone={(d) => { setData(d); onChanged(); setOrderOpen(false); }} />
      <LostDialog open={lostOpen} onClose={() => setLostOpen(false)} onConfirm={async (reason) => { if (await patch("/stage", { stage: "lost", lostReason: reason }, "Conversa encerrada.")) setLostOpen(false); }} />
    </>
  );
}

// ---------------- Ficha do cliente ----------------

function ClientPanel({ data, open, onClose, onSave, onUseCart }: { data: ConversationDetail; open: boolean; onClose: () => void; onSave: (b: { name?: string; businessName: string | null; notes: string | null }) => Promise<boolean>; onUseCart: () => void }) {
  const c = data.conversation;
  const [name, setName] = useState(c.name ?? "");
  const [biz, setBiz] = useState(c.businessName ?? "");
  const [notes, setNotes] = useState(c.contactNotes ?? "");
  const dirty = name !== (c.name ?? "") || biz !== (c.businessName ?? "") || notes !== (c.contactNotes ?? "");
  const cart = c.botData?.cart ?? [];

  return (
    <aside className="att-side adm-card" data-open={open} aria-label="Ficha do cliente">
      <div className="att-side-head">
        <h2>Cliente</h2>
        <button className="adm-icon-btn att-side-close" onClick={onClose} aria-label="Fechar"><Icon name="x" className="icon-sm" /></button>
      </div>

      <section className="att-side-sec">
        <a className="att-wa-link" href={`https://wa.me/${c.phone}`} target="_blank" rel="noreferrer"><Icon name="phone" className="icon-sm" />{c.phoneLabel}</a>
        <label className="field"><span>Nome</span><input className="input" value={name} onChange={(e) => setName(e.target.value)} /></label>
        <label className="field"><span>Empresa (atacado)</span><input className="input" value={biz} onChange={(e) => setBiz(e.target.value)} placeholder="Ex.: Empório Vila Nova" /></label>
        <label className="field"><span>Observações fixas</span><textarea className="input" rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Preferências, combinados, forma de pagamento…" /></label>
        {dirty && <button className="btn btn-primary btn-sm" onClick={() => onSave({ name: name.trim() || undefined, businessName: biz.trim() || null, notes: notes.trim() || null })}>Salvar ficha</button>}
      </section>

      <section className="att-side-sec">
        <h3>Carrinho montado no chatbot</h3>
        {cart.length === 0 ? <p className="adm-muted att-small">Vazio.</p> : (
          <>
            <ul className="att-cart">
              {cart.map((l) => <li key={l.productId}><span>{l.quantity}× {l.name}</span><b>{brl(l.priceCents * l.quantity)}</b></li>)}
            </ul>
            {!c.closedAt && <button className="btn btn-outline btn-sm" onClick={onUseCart}>Usar no pedido</button>}
          </>
        )}
      </section>

      <section className="att-side-sec">
        <h3>Pedidos deste cliente</h3>
        {data.orders.length === 0 ? <p className="adm-muted att-small">Nenhum pedido ainda.</p> : (
          <ul className="att-orders">
            {data.orders.map((o) => (
              <li key={o.code}>
                <Link to={`/admin?q=${o.code}`}><b>{o.code}</b></Link>
                <span className="status" data-status={o.status}>{STATUS_LABEL[o.status]}</span>
                <small className="adm-muted">{shortDate(o.createdAt)} · {brl(o.totalCents)}{o.discountCents ? ` (−${brl(o.discountCents)})` : ""}</small>
              </li>
            ))}
          </ul>
        )}
      </section>

      {data.history.length > 0 && (
        <section className="att-side-sec">
          <h3>Conversas anteriores</h3>
          <ul className="att-history">
            {data.history.map((h) => (
              <li key={h.id}><button className="btn-ghost" onClick={() => select(h.id)}>{shortDate(h.createdAt)} · {TOPIC_LABEL[h.topic]}</button><span className="att-stage" data-stage={h.stage}>{STAGE_INFO[h.stage].short}</span></li>
            ))}
          </ul>
        </section>
      )}
    </aside>
  );
}

// ---------------- Fechar pedido pela conversa ----------------

type Line = { productId: number; mode: "unit" | "box"; quantity: number };

function linePrice(p: AdminProduct, l: Line) {
  if (l.mode === "unit") return { units: l.quantity, unitCents: p.retail.priceCents, total: p.retail.priceCents * l.quantity };
  const tiers = [...p.wholesale.tiers].sort((a, b) => a.minBoxes - b.minBoxes);
  const tier = tiers.findLast((t) => l.quantity >= t.minBoxes && (t.maxBoxes === null || l.quantity <= t.maxBoxes)) ?? tiers[0];
  const unitCents = tier?.unitPriceCents ?? p.retail.priceCents;
  const units = l.quantity * p.wholesale.boxSize;
  return { units, unitCents, total: unitCents * units };
}

function OrderDialog({ open, onClose, detail, onDone }: { open: boolean; onClose: () => void; detail: ConversationDetail; onDone: (d: ConversationDetail) => void }) {
  const { toast } = useStore();
  const products = useApi<{ products: AdminProduct[] }>(open ? "/admin/products" : null);
  const c = detail.conversation;
  const addr = c.botData?.address ?? {};
  const [lines, setLines] = useState<Line[]>([]);
  const [pick, setPick] = useState("");
  const [discount, setDiscount] = useState("");
  const [discountKind, setDiscountKind] = useState<"brl" | "pct">("brl");
  const [cep, setCep] = useState("");
  const [a, setA] = useState({ recipient: "", street: "", number: "", complement: "", district: "", city: "", state: "" });
  const [notes, setNotes] = useState("");
  const [quote, setQuote] = useState<{ region: string; feeCents: number; freeShippingOverCents: number | null; next: string | null } | { error: string } | null>(null);
  const [saving, setSaving] = useState(false);

  // Abre já com o carrinho do chatbot e o endereço que o cliente informou.
  useEffect(() => {
    if (!open) return;
    setLines((c.botData?.cart ?? []).map((l) => ({ productId: l.productId, mode: "unit", quantity: l.quantity })));
    setCep(c.botData?.cep ?? "");
    setA({ recipient: addr.recipient ?? c.businessName ?? c.name ?? "", street: addr.street ?? "", number: addr.number ?? "", complement: addr.complement ?? "", district: addr.district ?? "", city: addr.city ?? "", state: addr.state ?? "" });
    setDiscount(""); setNotes(""); setPick("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const cepDigits = cep.replace(/\D/g, "");
  useEffect(() => {
    if (cepDigits.length !== 8) { setQuote(null); return; }
    let alive = true;
    api<any>(`/delivery/cep/${cepDigits}`)
      .then((r) => alive && setQuote({ region: r.region, feeCents: r.feeCents, freeShippingOverCents: r.freeShippingOverCents, next: r.nextDelivery?.date ?? null }))
      .catch((e) => alive && setQuote({ error: e instanceof ApiError ? e.message : "CEP não encontrado" }));
    return () => { alive = false; };
  }, [cepDigits]);

  const byId = useMemo(() => new Map((products.data?.products ?? []).map((p) => [p.id, p])), [products.data]);
  const priced = lines.map((l) => ({ l, p: byId.get(l.productId) })).filter((x): x is { l: Line; p: AdminProduct } => !!x.p).map((x) => ({ ...x, ...linePrice(x.p, x.l) }));
  const subtotal = priced.reduce((s, x) => s + x.total, 0);
  const dRaw = discountKind === "pct" ? Math.round(subtotal * (Number(discount.replace(",", ".")) || 0) / 100) : toCents(discount || "0");
  const discountCents = Number.isFinite(dRaw) ? Math.max(0, Math.min(subtotal, dRaw)) : 0;
  const fee = quote && "region" in quote ? (quote.freeShippingOverCents !== null && subtotal >= quote.freeShippingOverCents ? 0 : quote.feeCents) : 0;
  const total = subtotal - discountCents + fee;

  const setLine = (i: number, patch: Partial<Line>) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  const addLine = () => {
    const id = Number(pick);
    if (!id) return;
    setLines((ls) => (ls.some((l) => l.productId === id && l.mode === "unit") ? ls : [...ls, { productId: id, mode: "unit", quantity: 1 }]));
    setPick("");
  };

  const submit = async () => {
    setSaving(true);
    try {
      const res = await api<ConversationDetail & { order: { code: string } }>(`/admin/atendimento/${c.id}/order`, {
        body: { items: lines, discountCents, cep: cepDigits, address: { ...a, complement: a.complement || undefined }, notes: notes || undefined },
      });
      toast({ message: `Pedido ${res.order.code} criado e enviado ao cliente no WhatsApp.`, href: `/admin?q=${res.order.code}`, hrefLabel: "Ver pedido" });
      onDone(res);
    } catch (e) {
      toast({ message: e instanceof ApiError ? (e.details?.[0] ? `${e.message}: ${e.details[0].field} — ${e.details[0].message}` : e.message) : "Não foi possível criar o pedido", kind: "error" });
    } finally { setSaving(false); }
  };

  const valid = priced.length > 0 && quote && "region" in quote && a.recipient && a.street && a.number && a.district && a.city && a.state.length === 2;

  return (
    <Dialog open={open} onClose={onClose} title={`Fechar pedido · ${c.name ?? c.phoneLabel}`} wide>
      <div className="adm-form att-order">
        <p className="adm-muted att-small">O pedido entra direto em <b>Pedidos</b> (reserva o estoque) e o resumo é enviado ao cliente no WhatsApp. Preço negociado? Use o desconto.</p>

        <h3>Itens</h3>
        {products.loading && <div className="skeleton" style={{ height: 80 }} />}
        <table className="adm-table att-order-table" style={{ minWidth: 0 }}>
          <thead><tr><th>Produto</th><th>Venda</th><th>Qtd.</th><th className="num">Preço</th><th className="num">Total</th><th /></tr></thead>
          <tbody>
            {priced.length === 0 && <tr><td colSpan={6} className="adm-empty">Adicione os produtos combinados com o cliente.</td></tr>}
            {priced.map(({ l, p, units, unitCents, total: t }, i) => {
              const over = units > (p.availableUnits ?? p.stock.units);
              return (
                <tr key={`${l.productId}-${i}`}>
                  <td><span className="adm-strong">{p.name}</span><small className={over ? "adm-warn" : "adm-muted"}>{over ? `Só ${p.stock.units} un disponíveis` : `${p.stock.units} un disponíveis`}</small></td>
                  <td>
                    <select className="select att-mini" value={l.mode} onChange={(e) => setLine(i, { mode: e.target.value as Line["mode"] })} aria-label="Unidade ou caixa">
                      <option value="unit">Unidade</option>
                      <option value="box">Caixa c/ {p.wholesale.boxSize}</option>
                    </select>
                  </td>
                  <td><input className="input att-mini" type="number" min={1} value={l.quantity} onChange={(e) => setLine(i, { quantity: Math.max(1, Number(e.target.value) || 1) })} aria-label="Quantidade" /></td>
                  <td className="num">{brl(unitCents)}<small className="adm-muted">/un</small></td>
                  <td className="num">{brl(t)}</td>
                  <td className="actions"><button className="adm-icon-btn" onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))} aria-label="Remover"><Icon name="trash" className="icon-sm" /></button></td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <div className="att-add-line">
          <select className="select" value={pick} onChange={(e) => setPick(e.target.value)} aria-label="Adicionar produto">
            <option value="">Adicionar produto…</option>
            {(products.data?.products ?? []).filter((p) => p.active).map((p) => <option key={p.id} value={p.id}>{p.name} — {brl(p.retail.priceCents)}</option>)}
          </select>
          <button className="btn btn-outline btn-sm" onClick={addLine} disabled={!pick}><Icon name="plus" className="icon-sm" />Adicionar</button>
        </div>

        <div className="att-order-grid">
          <div className="adm-form" style={{ padding: 0 }}>
            <h3>Entrega</h3>
            <div className="att-row2">
              <label className="field"><span>CEP</span><input className="input" value={cepMask(cep)} onChange={(e) => setCep(e.target.value)} inputMode="numeric" /></label>
              <label className="field"><span>Quem recebe</span><input className="input" value={a.recipient} onChange={(e) => setA({ ...a, recipient: e.target.value })} /></label>
            </div>
            {quote && ("error" in quote ? <small className="adm-warn">{quote.error}</small> : <small className="adm-muted">Região {quote.region}{quote.next ? ` · próxima rota ${shortDate(quote.next)}` : ""}</small>)}
            <div className="att-row2">
              <label className="field" style={{ flex: 3 }}><span>Rua</span><input className="input" value={a.street} onChange={(e) => setA({ ...a, street: e.target.value })} /></label>
              <label className="field" style={{ flex: 1 }}><span>Número</span><input className="input" value={a.number} onChange={(e) => setA({ ...a, number: e.target.value })} /></label>
            </div>
            <div className="att-row2">
              <label className="field"><span>Complemento</span><input className="input" value={a.complement} onChange={(e) => setA({ ...a, complement: e.target.value })} /></label>
              <label className="field"><span>Bairro</span><input className="input" value={a.district} onChange={(e) => setA({ ...a, district: e.target.value })} /></label>
            </div>
            <div className="att-row2">
              <label className="field" style={{ flex: 3 }}><span>Cidade</span><input className="input" value={a.city} onChange={(e) => setA({ ...a, city: e.target.value })} /></label>
              <label className="field" style={{ flex: 1 }}><span>UF</span><input className="input" maxLength={2} value={a.state} onChange={(e) => setA({ ...a, state: e.target.value.toUpperCase() })} /></label>
            </div>
            <label className="field"><span>Observações do pedido</span><input className="input" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Ex.: entregar pela manhã" /></label>
          </div>

          <div className="att-summary">
            <h3>Resumo</h3>
            <div className="att-sum-row"><span>Subtotal</span><b>{brl(subtotal)}</b></div>
            <div className="att-discount">
              <span>Desconto negociado</span>
              <div className="adm-seg">
                <button aria-pressed={discountKind === "brl"} onClick={() => setDiscountKind("brl")}>R$</button>
                <button aria-pressed={discountKind === "pct"} onClick={() => setDiscountKind("pct")}>%</button>
              </div>
              <input className="input att-mini" value={discount} onChange={(e) => setDiscount(e.target.value)} placeholder={discountKind === "pct" ? "5" : "0,00"} inputMode="decimal" aria-label="Desconto" />
            </div>
            {discountCents > 0 && <div className="att-sum-row adm-neg"><span>Desconto</span><b>−{brl(discountCents)}</b></div>}
            <div className="att-sum-row"><span>Frete refrigerado</span><b>{quote && "region" in quote ? (fee ? brl(fee) : "Grátis") : "—"}</b></div>
            <div className="att-sum-row total"><span>Total</span><b>{brl(total)}</b></div>
            {discountCents > 0 && <small className="adm-muted">{((discountCents / Math.max(1, subtotal)) * 100).toFixed(1).replace(".", ",")}% sobre os produtos (R$ {fromCents(discountCents)})</small>}
            <button className="btn btn-primary btn-block" disabled={!valid || saving} onClick={submit}>
              {saving ? <Icon name="loader" className="icon spin" /> : <Icon name="checkCircle" className="icon-sm" />}Criar pedido e avisar cliente
            </button>
          </div>
        </div>
      </div>
    </Dialog>
  );
}

function LostDialog({ open, onClose, onConfirm }: { open: boolean; onClose: () => void; onConfirm: (reason: string) => void }) {
  const [reason, setReason] = useState("");
  const [other, setOther] = useState("");
  useEffect(() => { if (open) { setReason(""); setOther(""); } }, [open]);
  const final = reason === "Outro" ? other.trim() : reason;
  return (
    <Dialog open={open} onClose={onClose} title="Encerrar sem pedido">
      <div className="adm-form">
        <p className="adm-muted att-small">O motivo aparece no Dashboard e ajuda a entender por que vendas não fecham.</p>
        <div className="att-reasons">
          {LOST_REASONS.map((r) => <button key={r} className="chip" aria-pressed={reason === r} onClick={() => setReason(r)}>{r}</button>)}
        </div>
        {reason === "Outro" && <input className="input" value={other} onChange={(e) => setOther(e.target.value)} placeholder="Descreva o motivo" autoFocus />}
        <div className="adm-form-actions">
          <button className="btn btn-outline btn-sm" onClick={onClose}>Voltar</button>
          <button className="btn btn-sm adm-btn-danger" disabled={!final} onClick={() => onConfirm(final)}>Encerrar conversa</button>
        </div>
      </div>
    </Dialog>
  );
}

function GuideDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const steps: { stage: Stage; who: string }[] = [
    { stage: "bot", who: "Chatbot" },
    { stage: "waiting", who: "Fila" },
    { stage: "negotiating", who: "Você" },
    { stage: "awaiting_customer", who: "Cliente" },
  ];
  return (
    <Dialog open={open} onClose={onClose} title="Como funciona o atendimento" wide>
      <div className="adm-panel att-guide">
        <ol className="att-guide-flow">
          {steps.map((s) => (
            <li key={s.stage}>
              <span className="att-stage lg" data-stage={s.stage}>{STAGE_INFO[s.stage].label}</span>
              <p>{STAGE_INFO[s.stage].help}</p>
            </li>
          ))}
          <li>
            <span className="att-stage lg" data-stage="won">Fechada</span>
            <p>Com pedido (botão <b>Fechar pedido</b>) ou sem pedido (com o motivo).</p>
          </li>
        </ol>
        <div className="att-guide-cols">
          <div>
            <h3>O que o chatbot faz sozinho</h3>
            <ul>
              <li>Mostra produtos, preços e o que tem em estoque</li>
              <li>Monta o carrinho e calcula o frete pelo CEP</li>
              <li>Coleta o endereço e cria o pedido (reserva o estoque)</li>
              <li>Informa a situação dos pedidos do cliente</li>
              <li>Avisa o cliente a cada etapa do pedido (confirmado, em rota, entregue)</li>
            </ul>
          </div>
          <div>
            <h3>Quando chama uma pessoa</h3>
            <ul>
              <li>O cliente digita <b>atendente</b> ou escolhe essa opção</li>
              <li>Compra para empresa / atacado (negociação)</li>
              <li>Reclamação ou problema com pedido</li>
              <li>Pedido criado pelo bot (para combinar o pagamento)</li>
              <li>O bot não entende o cliente 3 vezes seguidas</li>
            </ul>
          </div>
        </div>
        <p className="adm-muted att-small">Dica: enquanto um responsável está na conversa, o chatbot fica em silêncio. Use <b>Devolver ao chatbot</b> quando terminar.</p>
      </div>
    </Dialog>
  );
}

function SettingsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { toast } = useStore();
  const { data } = useApi<{ settings: { number: string; displayNumber: string; hours: string }; transport: string }>(open ? "/admin/atendimento/settings" : null);
  const [form, setForm] = useState({ number: "", displayNumber: "", hours: "" });
  const [saving, setSaving] = useState(false);
  useEffect(() => { if (data) setForm(data.settings); }, [data]);
  const save = async () => {
    setSaving(true);
    try {
      await api("/admin/atendimento/settings", { method: "PUT", body: form });
      toast({ message: "Configurações salvas. Os botões do site já usam o novo número." });
      onClose();
    } catch (e) {
      toast({ message: e instanceof ApiError ? (e.details?.[0]?.message ?? e.message) : "Não foi possível salvar", kind: "error" });
    } finally { setSaving(false); }
  };
  return (
    <Dialog open={open} onClose={onClose} title="Configurações do WhatsApp">
      <div className="adm-form">
        <label className="field"><span>Número do WhatsApp (com DDI e DDD)</span><input className="input" value={form.number} onChange={(e) => setForm({ ...form, number: e.target.value })} placeholder="5531999990000" inputMode="numeric" /><small className="adm-muted">Usado nos botões “Pedir pelo WhatsApp” do site.</small></label>
        <label className="field"><span>Como o número aparece no site</span><input className="input" value={form.displayNumber} onChange={(e) => setForm({ ...form, displayNumber: e.target.value })} placeholder="(31) 99999-0000" /></label>
        <label className="field"><span>Horário de atendimento humano</span><input className="input" value={form.hours} onChange={(e) => setForm({ ...form, hours: e.target.value })} /><small className="adm-muted">O chatbot informa esse horário quando transfere para um responsável.</small></label>
        <div className="adm-alert" style={{ margin: 0 }}>
          <Icon name="phone" />
          <span><b>Conexão: {data?.transport === "simulador" ? "modo simulador" : data?.transport ?? "…"}</b> As respostas ficam registradas no painel e podem ser testadas em Simulador. Para enviar ao WhatsApp real, é preciso ligar a API oficial (veja o README).</span>
        </div>
        <div className="adm-form-actions">
          <button className="btn btn-outline btn-sm" onClick={onClose}>Cancelar</button>
          <button className="btn btn-primary btn-sm" onClick={save} disabled={saving}>Salvar</button>
        </div>
      </div>
    </Dialog>
  );
}
