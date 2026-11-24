import { useState } from "react";
import { api, ApiError } from "../api";
import { brl, dateTime, STATUS_LABEL } from "../format";
import { Icon } from "../icons";
import { useApi, useStore } from "../store";
import { Dialog } from "./Dialog";
import { timeAgo, toCents } from "./types";

// Painel → Solicitações: tudo o que chega pelo site e precisa de resposta dos donos
// (cotações de atacado, propostas de novos produtores e mensagens do “Fale conosco”).

type QuoteItem = { name?: string; productName?: string; quantity?: number; boxes?: number; mode?: string };
type Quote = { code: string; status: string; items: QuoteItem[] | string; estimatedTotalCents: number; notes: string | null; createdAt: string; buyerName: string; tradeName: string | null };
type Proposal = { protocol: string; status: string; responsibleName: string; propertyName: string; city: string; state: string; mainProductType: string; monthlyVolumeKg: number | null; certifications: string[]; submittedAt: string };
type Message = { id: number; topic: string; name: string; email: string; phone: string | null; message: string; handled: boolean; createdAt: string };

const TABS = [
  { id: "quotes", label: "Cotações de atacado" },
  { id: "proposals", label: "Propostas de produtores" },
  { id: "messages", label: "Mensagens do site" },
] as const;

const TOPIC: Record<string, string> = { general: "Geral", wholesale: "Atacado", partnership: "Parceria", order: "Pedido" };

export function RequestsPage() {
  const [tab, setTab] = useState<(typeof TABS)[number]["id"]>("quotes");
  const quotes = useApi<{ quotes: Quote[] }>("/admin/quotes");
  const proposals = useApi<{ proposals: Proposal[] }>("/admin/proposals");
  const messages = useApi<{ messages: Message[] }>("/admin/messages");
  const open = {
    quotes: quotes.data?.quotes.filter((q) => q.status === "open").length ?? 0,
    proposals: proposals.data?.proposals.filter((p) => ["submitted", "in_review"].includes(p.status)).length ?? 0,
    messages: messages.data?.messages.filter((m) => !m.handled).length ?? 0,
  };

  return (
    <>
      <div className="adm-head">
        <div>
          <h1>Solicitações</h1>
          <p>Pedidos de cotação, propostas de novos produtores e mensagens que chegam pelo site. As negociações pelo WhatsApp ficam em Atendimento.</p>
        </div>
      </div>
      <div className="adm-toolbar">
        <div className="adm-seg" role="group" aria-label="Tipo de solicitação">
          {TABS.map((t) => (
            <button key={t.id} aria-pressed={tab === t.id} onClick={() => setTab(t.id)}>
              {t.label}{open[t.id] > 0 && <span className="adm-count">{open[t.id]}</span>}
            </button>
          ))}
        </div>
      </div>
      {tab === "quotes" && <QuotesTab data={quotes.data?.quotes} loading={quotes.loading} reload={quotes.reload} />}
      {tab === "proposals" && <ProposalsTab data={proposals.data?.proposals} loading={proposals.loading} reload={proposals.reload} />}
      {tab === "messages" && <MessagesTab data={messages.data?.messages} loading={messages.loading} reload={messages.reload} />}
    </>
  );
}

function QuotesTab({ data, loading, reload }: { data?: Quote[]; loading: boolean; reload: () => void }) {
  const { toast } = useStore();
  const [answering, setAnswering] = useState<Quote | null>(null);
  const [form, setForm] = useState({ total: "", message: "", validUntil: "" });
  const submit = async () => {
    try {
      await api(`/admin/quotes/${answering!.code}/answer`, { body: { offeredTotalCents: toCents(form.total), message: form.message, validUntil: form.validUntil } });
      toast({ message: `Cotação ${answering!.code} respondida.` });
      setAnswering(null);
      reload();
    } catch (e) { toast({ message: e instanceof ApiError ? e.message : "Erro ao responder", kind: "error" }); }
  };
  const items = (q: Quote): QuoteItem[] => (typeof q.items === "string" ? JSON.parse(q.items) : q.items);
  return (
    <div className="adm-card">
      <div className="adm-table-wrap">
        <table className="adm-table">
          <thead><tr><th>Cotação</th><th>Empresa</th><th>Itens</th><th className="num">Estimado</th><th>Status</th><th className="actions" /></tr></thead>
          <tbody>
            {loading && !data && <tr><td colSpan={6}><div className="skeleton" style={{ height: 120 }} /></td></tr>}
            {data?.length === 0 && <tr><td colSpan={6} className="adm-empty">Nenhuma cotação recebida.</td></tr>}
            {data?.map((q) => (
              <tr key={q.code}>
                <td><b className="adm-code">{q.code}</b><small className="adm-muted">{timeAgo(q.createdAt)}</small></td>
                <td><span className="adm-strong">{q.tradeName ?? q.buyerName}</span><small className="adm-muted">{q.buyerName}</small></td>
                <td className="adm-items-cell">
                  {items(q).slice(0, 3).map((it, i) => <span key={i} className="adm-item-line">{it.boxes ?? it.quantity} {it.mode === "unit" ? "un" : "cx"} {it.productName ?? it.name}</span>)}
                  {q.notes && <small className="adm-muted">“{q.notes}”</small>}
                </td>
                <td className="num">{brl(q.estimatedTotalCents)}</td>
                <td><span className="status" data-status={q.status}>{STATUS_LABEL[q.status] ?? q.status}</span></td>
                <td className="actions">{q.status === "open" && <button className="btn btn-primary btn-sm" onClick={() => { setAnswering(q); setForm({ total: (q.estimatedTotalCents / 100).toFixed(2).replace(".", ","), message: "", validUntil: new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10) }); }}>Responder</button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Dialog open={!!answering} onClose={() => setAnswering(null)} title={`Responder ${answering?.code ?? ""}`}>
        <div className="adm-form">
          <label className="field"><span>Valor oferecido (R$)</span><input className="input" value={form.total} onChange={(e) => setForm({ ...form, total: e.target.value })} inputMode="decimal" /></label>
          <label className="field"><span>Mensagem</span><textarea className="input" rows={3} value={form.message} onChange={(e) => setForm({ ...form, message: e.target.value })} placeholder="Condições, prazo de pagamento, frete…" /></label>
          <label className="field"><span>Válida até</span><input className="input" type="date" value={form.validUntil} onChange={(e) => setForm({ ...form, validUntil: e.target.value })} /></label>
          <div className="adm-form-actions">
            <button className="btn btn-outline btn-sm" onClick={() => setAnswering(null)}>Cancelar</button>
            <button className="btn btn-primary btn-sm" disabled={!form.message.trim() || !(toCents(form.total) > 0)} onClick={submit}>Enviar resposta</button>
          </div>
        </div>
      </Dialog>
    </div>
  );
}

function ProposalsTab({ data, loading, reload }: { data?: Proposal[]; loading: boolean; reload: () => void }) {
  const { toast } = useStore();
  const setStatus = async (p: Proposal, status: string) => {
    try {
      await api(`/admin/proposals/${p.protocol}`, { method: "PATCH", body: { status } });
      toast({ message: `Proposta ${p.protocol}: ${STATUS_LABEL[status]?.toLowerCase()}.` });
      reload();
    } catch (e) { toast({ message: e instanceof ApiError ? e.message : "Erro", kind: "error" }); }
  };
  return (
    <div className="adm-card">
      <div className="adm-table-wrap">
        <table className="adm-table">
          <thead><tr><th>Protocolo</th><th>Produtor</th><th>Produto</th><th className="num">Volume/mês</th><th>Selos</th><th>Status</th><th className="actions" /></tr></thead>
          <tbody>
            {loading && !data && <tr><td colSpan={7}><div className="skeleton" style={{ height: 120 }} /></td></tr>}
            {data?.length === 0 && <tr><td colSpan={7} className="adm-empty">Nenhuma proposta enviada.</td></tr>}
            {data?.map((p) => (
              <tr key={p.protocol}>
                <td><b className="adm-code">{p.protocol}</b><small className="adm-muted">{p.submittedAt ? timeAgo(p.submittedAt) : ""}</small></td>
                <td><span className="adm-strong">{p.propertyName}</span><small className="adm-muted">{p.responsibleName} · {p.city}/{p.state}</small></td>
                <td>{p.mainProductType}</td>
                <td className="num">{p.monthlyVolumeKg ? `${p.monthlyVolumeKg.toLocaleString("pt-BR")} kg` : "—"}</td>
                <td><small>{p.certifications.join(", ") || "—"}</small></td>
                <td><span className="status" data-status={p.status}>{STATUS_LABEL[p.status]}</span></td>
                <td className="actions">
                  {p.status === "submitted" && <button className="btn btn-outline btn-sm" onClick={() => setStatus(p, "in_review")}>Analisar</button>}
                  {["submitted", "in_review"].includes(p.status) && (
                    <>
                      {" "}<button className="btn btn-primary btn-sm" onClick={() => setStatus(p, "approved")}>Aprovar</button>
                      {" "}<button className="btn btn-sm adm-btn-ghost-danger" onClick={() => setStatus(p, "rejected")}>Recusar</button>
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function MessagesTab({ data, loading, reload }: { data?: Message[]; loading: boolean; reload: () => void }) {
  const { toast } = useStore();
  const toggle = async (m: Message) => {
    try {
      await api(`/admin/messages/${m.id}`, { method: "PATCH", body: { handled: !m.handled } });
      reload();
    } catch (e) { toast({ message: e instanceof ApiError ? e.message : "Erro", kind: "error" }); }
  };
  if (loading && !data) return <div className="skeleton" style={{ height: 160 }} />;
  if (!data?.length) return <div className="adm-card"><p className="adm-empty" style={{ margin: 0 }}>Nenhuma mensagem recebida pelo site.</p></div>;
  return (
    <ul className="req-messages">
      {data.map((m) => (
        <li key={m.id} className="adm-card" data-handled={m.handled}>
          <div className="req-msg-head">
            <b>{m.name}</b><span className="att-topic">{TOPIC[m.topic] ?? m.topic}</span>
            <small className="adm-muted">{dateTime(m.createdAt)}</small>
          </div>
          <p>{m.message}</p>
          <div className="req-msg-actions">
            <a className="btn btn-outline btn-sm" href={`mailto:${m.email}`}><Icon name="mail" className="icon-sm" />{m.email}</a>
            {m.phone && <a className="btn btn-outline btn-sm" href={`https://wa.me/${m.phone.replace(/\D/g, "").replace(/^(?!55)/, "55")}`} target="_blank" rel="noreferrer"><Icon name="phone" className="icon-sm" />{m.phone}</a>}
            <button className={`btn btn-sm ${m.handled ? "btn-outline" : "btn-primary"}`} onClick={() => toggle(m)}>
              <Icon name="check" className="icon-sm" />{m.handled ? "Reabrir" : "Marcar como respondida"}
            </button>
          </div>
        </li>
      ))}
    </ul>
  );
}
