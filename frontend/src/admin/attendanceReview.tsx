import { useEffect, useState } from "react";
import { api, ApiError } from "../api";
import { dateTime } from "../format";
import { Icon } from "../icons";
import { useStore } from "../store";
import { BOT_STATE_LABEL, clock, WaText, type ChatMessage, type ConversationDetail, type Review } from "./attendance";
import { Dialog } from "./Dialog";

// Atendimento interativo: aprovar respostas do robô (modo supervisionado), ver por que ele respondeu,
// avaliar cada resposta, validar a conversa e ensinar o robô a partir do que a equipe escreveu.

type Run = (path: string, body: unknown, ok?: string) => Promise<boolean>;

// ---------- bolha de mensagem ----------

export function ChatBubble({ m, prevCustomer, run, onTeach, busy }: {
  m: ChatMessage; prevCustomer: string; run: Run; onTeach: (question: string, answer: string) => void; busy: boolean;
}) {
  const [why, setWhy] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(m.body);
  const [badNote, setBadNote] = useState<string | null>(null);
  useEffect(() => setDraft(m.body), [m.body]);

  const pending = m.status === "pending";
  const who = m.author === "bot" ? (m.meta?.engine === "ia" ? "🤖 Robô com IA" : "🤖 Chatbot") : m.author === "note" ? "📝 Nota interna" : m.agentName ?? "Responsável";

  return (
    <div className="att-msg" data-author={m.author} data-status={m.status}>
      <div className="att-bubble">
        {m.author !== "customer" && (
          <span className="att-msg-who">
            {who}{m.author === "note" && m.agentName ? ` · ${m.agentName}` : ""}
            {pending && <span className="rv-tag pending">aguardando aprovação</span>}
            {m.status === "discarded" && <span className="rv-tag">descartada{m.approvedBy ? ` por ${m.approvedBy}` : ""}</span>}
            {m.approval === "edited" && <span className="rv-tag">editada{m.approvedBy ? ` por ${m.approvedBy}` : ""}</span>}
            {m.approval === "approved" && <span className="rv-tag ok">aprovada{m.approvedBy ? ` por ${m.approvedBy}` : ""}</span>}
          </span>
        )}
        {editing
          ? <textarea className="input rv-edit" rows={Math.min(8, draft.split("\n").length + 1)} value={draft} onChange={(e) => setDraft(e.target.value)} aria-label="Editar resposta do robô" autoFocus />
          : <WaText text={m.body} />}
        <time>{clock(m.createdAt)}</time>

        {pending && (
          <div className="rv-actions">
            {editing ? (
              <>
                <button className="btn btn-primary btn-sm" disabled={busy || !draft.trim()} onClick={async () => { if (await run("/pending/approve", { messageId: m.id, body: draft }, "Resposta editada enviada.")) setEditing(false); }}>Enviar editada</button>
                <button className="btn btn-outline btn-sm" onClick={() => { setEditing(false); setDraft(m.body); }}>Cancelar</button>
              </>
            ) : (
              <>
                <button className="btn btn-primary btn-sm" disabled={busy} onClick={() => run("/pending/approve", { messageId: m.id }, "Resposta enviada ao cliente.")}><Icon name="check" className="icon-sm" />Enviar</button>
                <button className="btn btn-outline btn-sm" disabled={busy} onClick={() => setEditing(true)}>Editar</button>
                <button className="btn btn-sm adm-btn-ghost-danger" disabled={busy} onClick={() => run("/pending/discard", { messageId: m.id }, "Resposta descartada.")}>Descartar</button>
              </>
            )}
          </div>
        )}

        {m.author === "bot" && m.status === "sent" && (
          <div className="rv-tools">
            {m.meta && <button className="rv-link" onClick={() => setWhy((w) => !w)} aria-expanded={why}>Por quê?</button>}
            <button className="rv-thumb" aria-pressed={m.rating === "good"} aria-label="Boa resposta" title="Boa resposta"
              onClick={() => run(`/messages/${m.id}/rating`, { rating: m.rating === "good" ? null : "good" })}>👍</button>
            <button className="rv-thumb" aria-pressed={m.rating === "bad"} aria-label="Resposta ruim" title="Resposta ruim — o que deveria ter dito?"
              onClick={() => (m.rating === "bad" ? run(`/messages/${m.id}/rating`, { rating: null }) : setBadNote(""))}>👎</button>
          </div>
        )}
        {m.author === "agent" && (
          <div className="rv-tools">
            <button className="rv-link" onClick={() => onTeach(prevCustomer, m.body)}><Icon name="sparkle" className="icon-sm" />Ensinar ao robô</button>
          </div>
        )}

        {why && m.meta && (
          <div className="rv-why">
            <b>{m.meta.engine === "ia" ? "Respondido pela IA" : "Respondido pelo robô de regras"}</b>
            {m.meta.trace.length > 0
              ? <ul>{m.meta.trace.map((t, i) => <li key={i}>{t}</li>)}</ul>
              : <span>{m.meta.engine === "ia" ? "Respondeu só com o conhecimento da loja, sem consultar o sistema." : `Etapa da conversa: ${BOT_STATE_LABEL[m.meta.state] ?? m.meta.state}.`}</span>}
            {m.meta.handoff && <span>Chamou a equipe: {m.meta.handoff}</span>}
          </div>
        )}

        {m.rating === "bad" && m.ratingNote && <div className="rv-note">👎 {m.ratingNote}</div>}
        {badNote !== null && (
          <div className="rv-bad">
            <label className="field"><span>O que o robô deveria ter respondido? (opcional)</span>
              <textarea className="input" rows={2} value={badNote} onChange={(e) => setBadNote(e.target.value)} autoFocus />
            </label>
            <div className="rv-actions">
              <button className="btn btn-primary btn-sm" disabled={busy} onClick={async () => { if (await run(`/messages/${m.id}/rating`, { rating: "bad", note: badNote }, "Avaliação registrada.")) setBadNote(null); }}>Salvar avaliação</button>
              {badNote.trim().length > 1 && prevCustomer && (
                <button className="btn btn-outline btn-sm" onClick={async () => { if (await run(`/messages/${m.id}/rating`, { rating: "bad", note: badNote })) { onTeach(prevCustomer, badNote); setBadNote(null); } }}>Salvar e ensinar ao robô</button>
              )}
              <button className="btn btn-outline btn-sm" onClick={() => setBadNote(null)}>Cancelar</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ---------- barra de aprovação ----------

export function PendingBar({ count, run, busy }: { count: number; run: Run; busy: boolean }) {
  if (!count) return null;
  return (
    <div className="rv-pending-bar" role="status">
      <Icon name="clock" className="icon-sm" />
      <span><b>{count === 1 ? "1 resposta do robô" : `${count} respostas do robô`} esperando sua aprovação.</b> O cliente ainda não recebeu.</span>
      <span className="rv-actions">
        <button className="btn btn-primary btn-sm" disabled={busy} onClick={() => run("/pending/approve", {}, count === 1 ? "Resposta enviada." : "Respostas enviadas.")}>Enviar {count === 1 ? "" : "todas"}</button>
        <button className="btn btn-outline btn-sm" disabled={busy} onClick={() => run("/pending/discard", {}, "Descartadas. A conversa agora é sua.")}>Descartar e assumir</button>
      </span>
    </div>
  );
}

// ---------- ensinar ao robô ----------

export function TeachDialog({ open, initial, onClose }: { open: boolean; initial: { question: string; answer: string } | null; onClose: () => void }) {
  const { toast } = useStore();
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState("");
  const [words, setWords] = useState("");
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (!initial) return;
    setQuestion(initial.question.slice(0, 200));
    setAnswer(initial.answer.slice(0, 1000));
    setWords("");
  }, [initial]);
  const keywords = words.split(",").map((w) => w.trim()).filter((w) => w.length >= 2);

  const save = async () => {
    setSaving(true);
    try {
      await api("/admin/robo/teach", { body: { question, answer, keywords } });
      toast({ message: "Ensinado! Está no rascunho da Central do Robô: publique para valer com os clientes.", href: "/admin/robo", hrefLabel: "Abrir Central" });
      onClose();
    } catch (e) {
      toast({ message: e instanceof ApiError ? (e.details?.[0]?.message ?? e.message) : "Não foi possível salvar", kind: "error" });
    } finally { setSaving(false); }
  };

  return (
    <Dialog open={open} onClose={onClose} title="Ensinar ao robô">
      <div className="adm-form">
        <p className="adm-muted" style={{ margin: 0 }}>Vira uma pergunta frequente no rascunho da Central do Robô. Revise o texto: ele vai ser usado com outros clientes, então tire dados pessoais.</p>
        <label className="field"><span>Quando o cliente perguntar…</span><input className="input" maxLength={200} value={question} onChange={(e) => setQuestion(e.target.value)} /></label>
        <label className="field"><span>…o robô responde</span><textarea className="input" rows={4} maxLength={1000} value={answer} onChange={(e) => setAnswer(e.target.value)} /></label>
        <label className="field"><span>Palavras-chave (separe por vírgula)</span><input className="input" value={words} onChange={(e) => setWords(e.target.value)} placeholder="Ex.: cesta, presente" />
          <small className="adm-muted">O robô de regras responde quando o cliente escreve uma delas.</small>
        </label>
        <div className="adm-form-actions">
          <button className="btn btn-outline btn-sm" onClick={onClose}>Cancelar</button>
          <button className="btn btn-primary btn-sm" onClick={save} disabled={saving || question.trim().length < 3 || answer.trim().length < 2 || !keywords.length}>
            {saving && <Icon name="loader" className="icon-sm spin" />}Salvar no rascunho
          </button>
        </div>
      </div>
    </Dialog>
  );
}

// ---------- validação da conversa ----------

const REVIEWS: { id: Review; label: string; help: string }[] = [
  { id: "ok", label: "✓ Correta", help: "O atendimento foi bom do começo ao fim." },
  { id: "corrigida", label: "✎ Corrigida", help: "A equipe precisou ajustar alguma resposta." },
  { id: "problema", label: "⚠ Problema", help: "Algo saiu errado e precisa de atenção." },
];

export function ReviewSection({ detail, onSave }: { detail: ConversationDetail; onSave: (review: Review | null, note?: string) => Promise<boolean> }) {
  const c = detail.conversation;
  const [note, setNote] = useState(c.reviewNote ?? "");
  useEffect(() => setNote(c.reviewNote ?? ""), [c.reviewNote]);
  return (
    <section className="att-side-sec">
      <h3>Validação da conversa</h3>
      <div className="rv-review" role="group" aria-label="Validar conversa">
        {REVIEWS.map((r) => (
          <button key={r.id} className="chip" data-review={r.id} aria-pressed={c.review === r.id} title={r.help}
            onClick={() => onSave(c.review === r.id ? null : r.id, note)}>{r.label}</button>
        ))}
      </div>
      {c.review && (
        <>
          <textarea className="input" rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Observação (opcional)" aria-label="Observação da validação" />
          {note !== (c.reviewNote ?? "") && <button className="btn btn-outline btn-sm" onClick={() => onSave(c.review, note)}>Salvar observação</button>}
          {c.reviewedAt && <small className="adm-muted">{c.reviewedBy ? `${c.reviewedBy} · ` : ""}{dateTime(c.reviewedAt)}</small>}
        </>
      )}
    </section>
  );
}
