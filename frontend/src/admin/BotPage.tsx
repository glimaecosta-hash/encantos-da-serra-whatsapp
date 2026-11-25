import { useEffect, useMemo, useState } from "react";
import { api, ApiError } from "../api";
import { brl, dateTime } from "../format";
import { Icon } from "../icons";
import { Link } from "../router";
import { useApi, useStore } from "../store";
import { WaText } from "./attendance";

// Painel → Robô (Central do Robô): os donos ensinam e ajustam o robô sem programador.
// Tudo é editado num rascunho, testado no Simulador e só então publicado para os clientes.

type Tone = "acolhedor" | "formal" | "descontraido";
type Faq = { id: string; question: string; answer: string; keywords: string[] };
type Knowledge = { fabrication: string; pairing: string; storage: string; notes: string };
type BotConfig = {
  persona: { name: string; tone: Tone; greeting: string; emojis: boolean };
  storeInfo: string;
  faqs: Faq[];
  products: Record<string, Knowledge>;
  rules: { maxDiscountPct: number; minOrderCents: number; upsell: boolean; freeShippingNudge: boolean; handoffKeywords: string[]; extraInstructions: string };
};
type Overview = {
  draft: BotConfig; published: BotConfig; hasChanges: boolean; publishedAt: string | null; publishedBy: string | null;
  versions: { index: number; publishedAt: string; publishedBy: string }[];
  openQuestions: number; products: { sku: string; name: string; category: string }[];
};
type Question = { id: number; question: string; source: "robo" | "ia"; times: number; conversationId: number | null; lastAskedAt: string; answer: string | null; answeredBy: string | null };

const TABS = [
  { id: "persona", label: "Personalidade", icon: "sparkle" },
  { id: "knowledge", label: "Conhecimento", icon: "layers" },
  { id: "products", label: "Produtos", icon: "box" },
  { id: "rules", label: "Regras de venda", icon: "sliders" },
  { id: "questions", label: "Perguntas sem resposta", icon: "chat" },
  { id: "quality", label: "Qualidade", icon: "trending" },
  { id: "versions", label: "Versões", icon: "route" },
] as const;
type TabId = (typeof TABS)[number]["id"];

const TONES: { id: Tone; label: string; example: string }[] = [
  { id: "acolhedor", label: "Acolhedor", example: "Que bom te ver por aqui! Esse canastra é uma delícia com café coado. 🧀" },
  { id: "formal", label: "Formal", example: "Boa tarde. O Canastra Meia-Cura tem 30 dias de maturação e sabor equilibrado." },
  { id: "descontraido", label: "Descontraído", example: "Ah, esse canastra é daqueles que somem da tábua rapidinho! 😄" },
];

const greetingPreview = (t: string) => t.replace(/\{([^{}]*)nome\}/g, "$1Mariana");
const newId = () => `f${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const emptyKnowledge: Knowledge = { fabrication: "", pairing: "", storage: "", notes: "" };

const parseWords = (t: string) => t.split(",").map((w) => w.trim()).filter(Boolean);

// Lista de palavras separadas por vírgula. O texto digitado fica como está (dá para digitar a vírgula);
// só é reescrito quando a lista muda por fora (ex.: descartar rascunho).
function WordsInput({ value, onChange, placeholder, label }: { value: string[]; onChange: (v: string[]) => void; placeholder?: string; label: string }) {
  const [text, setText] = useState(value.join(", "));
  useEffect(() => {
    setText((t) => (parseWords(t).join("|") === value.join("|") ? t : value.join(", ")));
  }, [value]);
  return (
    <input className="input" value={text} placeholder={placeholder} aria-label={label}
      onChange={(e) => { setText(e.target.value); onChange(parseWords(e.target.value)); }} />
  );
}

export function BotPage() {
  const { toast } = useStore();
  const { data, setData, loading } = useApi<Overview>("/admin/robo");
  const [form, setForm] = useState<BotConfig | null>(null);
  const [tab, setTab] = useState<TabId>("persona");
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => { if (data && !form) setForm(data.draft); }, [data]); // eslint-disable-line react-hooks/exhaustive-deps

  const dirty = !!form && !!data && JSON.stringify(form) !== JSON.stringify(data.draft);
  const unpublished = dirty || !!data?.hasChanges;

  const act = async (kind: string, fn: () => Promise<Overview>, ok: string) => {
    setBusy(kind);
    try {
      const o = await fn();
      setData(o);
      setForm(o.draft);
      toast({ message: ok });
      return true;
    } catch (e) {
      toast({ message: e instanceof ApiError ? (e.details?.[0]?.message ?? e.message) : "Não foi possível salvar", kind: "error" });
      return false;
    } finally { setBusy(null); }
  };
  const saveDraft = () => act("save", () => api<Overview>("/admin/robo/draft", { method: "PUT", body: form }), "Rascunho salvo. Teste no Simulador antes de publicar.");
  const publish = async () => {
    if (dirty && !(await saveDraft())) return;
    await act("publish", () => api<Overview>("/admin/robo/publish", { body: {} }), "Publicado! Os clientes já conversam com a nova versão.");
  };
  const discard = () => act("discard", () => api<Overview>("/admin/robo/discard", { body: {} }), "Rascunho descartado. Voltou a versão publicada.");

  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => { if (dirty) e.preventDefault(); };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  if (loading && !data) return <div className="skeleton" style={{ height: 480 }} />;
  if (!data || !form) return null;

  const set = (patch: Partial<BotConfig>) => setForm((f) => (f ? { ...f, ...patch } : f));
  const setPersona = (patch: Partial<BotConfig["persona"]>) => set({ persona: { ...form.persona, ...patch } });
  const setRules = (patch: Partial<BotConfig["rules"]>) => set({ rules: { ...form.rules, ...patch } });

  return (
    <div className="bot">
      <div className="adm-head">
        <div>
          <h1>Central do Robô</h1>
          <p>Ensine e ajuste o robô do WhatsApp. As mudanças ficam num <b>rascunho</b>: teste no Simulador e, quando estiver bom, <b>publique</b> para os clientes.</p>
        </div>
        <div className="bot-actions">
          {dirty && <button className="btn btn-outline btn-sm" onClick={saveDraft} disabled={!!busy}>{busy === "save" && <Icon name="loader" className="icon-sm spin" />}Salvar rascunho</button>}
          <Link to="/admin/simulador?rascunho=1" className="btn btn-outline btn-sm" onClick={(e) => { if (dirty) { e.preventDefault(); toast({ message: "Salve o rascunho antes de testar.", kind: "error" }); } }}>
            <Icon name="phone" className="icon-sm" />Testar rascunho
          </Link>
          <button className="btn btn-primary btn-sm" onClick={publish} disabled={!!busy || !unpublished}>{busy === "publish" && <Icon name="loader" className="icon-sm spin" />}Publicar</button>
        </div>
      </div>

      <div className="bot-status" data-state={unpublished ? "draft" : "live"}>
        <Icon name={unpublished ? "sliders" : "checkCircle"} className="icon-sm" />
        {unpublished
          ? <span><b>{dirty ? "Alterações não salvas." : "Rascunho diferente da versão publicada."}</b> Os clientes ainda veem a versão publicada{data.publishedAt ? ` em ${dateTime(data.publishedAt)}` : ""}.</span>
          : <span><b>Tudo publicado.</b> {data.publishedAt ? `Versão de ${dateTime(data.publishedAt)}${data.publishedBy ? ` por ${data.publishedBy}` : ""}.` : "Usando a configuração padrão."}</span>}
        {data.hasChanges && !dirty && <button className="btn-link" onClick={discard} disabled={!!busy}>Descartar rascunho</button>}
      </div>

      <div className="adm-seg bot-tabs" role="tablist" aria-label="Seções da Central do Robô">
        {TABS.map((t) => (
          <button key={t.id} role="tab" aria-selected={tab === t.id} aria-pressed={tab === t.id} onClick={() => setTab(t.id)}>
            <Icon name={t.icon} className="icon-sm" />{t.label}
            {t.id === "questions" && data.openQuestions > 0 && <span className="adm-count">{data.openQuestions}</span>}
          </button>
        ))}
      </div>

      <div className="adm-card bot-card">
        {tab === "persona" && (
          <div className="adm-form">
            <label className="field"><span>Nome da atendente virtual</span>
              <input className="input" maxLength={40} value={form.persona.name} onChange={(e) => setPersona({ name: e.target.value })} placeholder="Ex.: Zita" />
              <small className="adm-muted">Como o robô se apresenta quando o cliente pergunta.</small>
            </label>
            <fieldset className="bot-tones">
              <legend>Jeito de falar</legend>
              {TONES.map((t) => (
                <label key={t.id} className="pay-provider" data-active={form.persona.tone === t.id}>
                  <input type="radio" name="tone" checked={form.persona.tone === t.id} onChange={() => setPersona({ tone: t.id })} />
                  <span><b>{t.label}</b><small className="adm-muted">“{t.example}”</small></span>
                </label>
              ))}
            </fieldset>
            <label className="field"><span>Mensagem de boas-vindas</span>
              <textarea className="input" rows={3} maxLength={300} value={form.persona.greeting} onChange={(e) => setPersona({ greeting: e.target.value })} />
              <small className="adm-muted">Escreva <code>{"{, nome}"}</code> onde entra o nome do cliente (some sozinho se ele não tiver nome).</small>
            </label>
            <div className="bot-preview"><span className="adm-muted">Prévia</span><div className="bot-bubble"><WaText text={greetingPreview(form.persona.greeting)} /></div></div>
            <label className="pay-check"><input type="checkbox" checked={form.persona.emojis} onChange={(e) => setPersona({ emojis: e.target.checked })} /><span>Usar emojis nas mensagens</span></label>
          </div>
        )}

        {tab === "knowledge" && (
          <div className="adm-form">
            <label className="field"><span>Sobre a loja (o robô pode afirmar isto)</span>
              <textarea className="input" rows={7} maxLength={4000} value={form.storeInfo} onChange={(e) => set({ storeInfo: e.target.value })} />
              <small className="adm-muted">Entrega, horários, diferenciais, trocas. Uma informação por linha. Pagamento é informado automaticamente pelo sistema.</small>
            </label>
            <div className="bot-section-head">
              <h3>Perguntas frequentes</h3>
              <button className="btn btn-outline btn-sm" onClick={() => set({ faqs: [...form.faqs, { id: newId(), question: "", answer: "", keywords: [] }] })}><Icon name="plus" className="icon-sm" />Adicionar pergunta</button>
            </div>
            <p className="adm-muted" style={{ margin: 0 }}>O robô com IA usa as respostas como base. O robô de regras responde sozinho quando o cliente escreve uma das <b>palavras-chave</b>.</p>
            {form.faqs.length === 0 && <div className="adm-empty">Nenhuma pergunta ainda. Dica: comece pelas que mais chegam no WhatsApp, ou responda as da aba “Perguntas sem resposta”.</div>}
            <ul className="bot-faqs">
              {form.faqs.map((f, i) => {
                const upd = (patch: Partial<Faq>) => set({ faqs: form.faqs.map((x, j) => (j === i ? { ...x, ...patch } : x)) });
                return (
                  <li key={f.id} className="bot-faq">
                    <label className="field"><span>Pergunta</span><input className="input" maxLength={200} value={f.question} onChange={(e) => upd({ question: e.target.value })} placeholder="Ex.: Vocês entregam no interior?" /></label>
                    <label className="field"><span>Resposta</span><textarea className="input" rows={2} maxLength={1000} value={f.answer} onChange={(e) => upd({ answer: e.target.value })} /></label>
                    <label className="field"><span>Palavras-chave (separe por vírgula)</span><WordsInput label="Palavras-chave" value={f.keywords} onChange={(keywords) => upd({ keywords })} placeholder="interior, entregam em" /></label>
                    <button className="btn-link bot-remove" onClick={() => set({ faqs: form.faqs.filter((_, j) => j !== i) })}><Icon name="trash" className="icon-sm" />Remover</button>
                  </li>
                );
              })}
            </ul>
          </div>
        )}

        {tab === "products" && <ProductsTab form={form} products={data.products} onChange={(products) => set({ products })} />}

        {tab === "rules" && (
          <div className="adm-form">
            <div className="form-grid">
              <label className="field"><span>Desconto máximo que a IA pode dar (%)</span>
                <input className="input" inputMode="numeric" value={form.rules.maxDiscountPct} onChange={(e) => setRules({ maxDiscountPct: Math.min(30, Number(e.target.value.replace(/\D/g, "")) || 0) })} />
                <small className="adm-muted">0 = nunca dá desconto (pedidos de desconto vão para a equipe). Só vale com o robô com IA.</small>
              </label>
              <label className="field"><span>Pedido mínimo (R$)</span>
                <input className="input" inputMode="numeric" value={Math.round(form.rules.minOrderCents / 100)} onChange={(e) => setRules({ minOrderCents: (Number(e.target.value.replace(/\D/g, "")) || 0) * 100 })} />
                <small className="adm-muted">{form.rules.minOrderCents ? `Pedidos abaixo de ${brl(form.rules.minOrderCents)} em produtos não fecham.` : "Sem mínimo."}</small>
              </label>
            </div>
            <label className="pay-check"><input type="checkbox" checked={form.rules.upsell} onChange={(e) => setRules({ upsell: e.target.checked })} /><span>Oferecer um complemento (ex.: doce de leite junto com o queijo)</span></label>
            <label className="pay-check"><input type="checkbox" checked={form.rules.freeShippingNudge} onChange={(e) => setRules({ freeShippingNudge: e.target.checked })} /><span>Avisar quanto falta para o frete grátis</span></label>
            <label className="field"><span>Palavras que chamam uma pessoa da equipe na hora</span>
              <WordsInput label="Palavras que chamam a equipe" value={form.rules.handoffKeywords} onChange={(handoffKeywords) => setRules({ handoffKeywords })} placeholder="nota fiscal, evento, casamento" />
              <small className="adm-muted">Além das automáticas (atendente, reclamação, atacado).</small>
            </label>
            <label className="field"><span>Orientações extras para a IA</span>
              <textarea className="input" rows={4} maxLength={2000} value={form.rules.extraInstructions} onChange={(e) => setRules({ extraInstructions: e.target.value })} placeholder="Ex.: Em dezembro, sugira nossas cestas de Natal. Não fazemos entregas aos domingos." />
              <small className="adm-muted">Não mudam preço, estoque, pagamento nem as regras de segurança: essas o sistema garante.</small>
            </label>
          </div>
        )}

        {tab === "questions" && (
          <QuestionsTab onAnswered={(o) => {
            setData(o);
            // Mantém o que estava sendo editado e acrescenta a nova pergunta frequente.
            setForm((f) => (f && dirty ? { ...f, faqs: [...f.faqs, o.draft.faqs.at(-1)!] } : o.draft));
          }} />
        )}

        {tab === "quality" && <QualityTab />}

        {tab === "versions" && (
          <div className="adm-form">
            <p className="adm-muted" style={{ margin: 0 }}>Cada publicação guarda a versão anterior. Para voltar, traga uma versão para o rascunho, teste e publique.</p>
            <ul className="bot-versions">
              <li data-current="true">
                <span><b>No ar agora</b><small className="adm-muted">{data.publishedAt ? `${dateTime(data.publishedAt)}${data.publishedBy ? ` · ${data.publishedBy}` : ""}` : "Configuração padrão"}</small></span>
              </li>
              {data.versions.map((v) => (
                <li key={v.index}>
                  <span><b>Versão de {dateTime(v.publishedAt)}</b><small className="adm-muted">{v.publishedBy}</small></span>
                  <button className="btn btn-outline btn-sm" disabled={!!busy} onClick={() => act("restore", () => api<Overview>(`/admin/robo/versions/${v.index}/restore`, { body: {} }), "Versão trazida para o rascunho. Teste e publique.")}>Trazer para o rascunho</button>
                </li>
              ))}
              {data.versions.length === 0 && <li className="adm-muted">Ainda não há versões anteriores.</li>}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}

type Quality = {
  days: number;
  conversations: { total: number; botOnly: number; handedOff: number; won: number; reviewOk: number; reviewFixed: number; reviewProblem: number; medianWaitSec: number | null };
  messages: { botSent: number; aiTurns: number; rulesTurns: number; approved: number; edited: number; discarded: number; pending: number; good: number; bad: number };
  orders: { byBot: number; byTeam: number };
  questions: { open: number; answered: number };
  badReplies: { id: number; body: string; note: string | null; conversationId: number; createdAt: string; ratedBy: string | null }[];
  problems: { id: number; note: string | null; reviewedAt: string; name: string | null; phone: string }[];
};

const pct = (n: number, total: number) => (total ? `${Math.round((n / total) * 100)}%` : "–");
const waitText = (sec: number | null) => (sec === null ? "–" : sec < 60 ? `${sec} s` : sec < 3600 ? `${Math.round(sec / 60)} min` : `${(sec / 3600).toFixed(1).replace(".", ",")} h`);

// Qualidade do atendimento: quanto o robô resolve sozinho, o que a equipe corrige e onde ele erra.
function QualityTab() {
  const [days, setDays] = useState(30);
  const { data } = useApi<Quality>(`/admin/robo/quality?days=${days}`);
  if (!data) return <div className="skeleton" style={{ height: 320 }} />;
  const c = data.conversations;
  const m = data.messages;
  const reviewed = c.reviewOk + c.reviewFixed + c.reviewProblem;
  const decided = m.approved + m.edited + m.discarded;
  const rated = m.good + m.bad;
  const kpis = [
    { label: "Resolvidas só pelo robô", value: pct(c.botOnly, c.total), hint: `${c.botOnly} de ${c.total} conversas` },
    { label: "Passaram para a equipe", value: pct(c.handedOff, c.total), hint: `espera mediana ${waitText(c.medianWaitSec)}` },
    { label: "Pedidos fechados pelo robô", value: String(data.orders.byBot), hint: `${data.orders.byTeam} pela equipe` },
    { label: "Respostas bem avaliadas", value: pct(m.good, rated), hint: `${m.good} 👍 · ${m.bad} 👎` },
    { label: "Aprovadas sem mudança", value: pct(m.approved, decided), hint: `${m.edited} editadas · ${m.discarded} descartadas${m.pending ? ` · ${m.pending} esperando` : ""}` },
    { label: "Conversas validadas como corretas", value: pct(c.reviewOk, reviewed), hint: `${c.reviewFixed} corrigidas · ${c.reviewProblem} com problema` },
  ];
  return (
    <div className="adm-form">
      <div className="bot-section-head">
        <p className="adm-muted" style={{ margin: 0 }}>Números das conversas iniciadas nos últimos {days} dias. Avaliações (👍/👎), aprovações e validações são feitas em Atendimento.</p>
        <div className="adm-seg" role="group" aria-label="Período">
          {[7, 30, 90].map((d) => <button key={d} aria-pressed={days === d} onClick={() => setDays(d)}>{d} dias</button>)}
        </div>
      </div>
      <div className="adm-kpis">
        {kpis.map((k) => (
          <div key={k.label} className="adm-kpi"><span className="adm-kpi-label">{k.label}</span><b>{k.value}</b><small>{k.hint}</small></div>
        ))}
      </div>
      <p className="adm-muted" style={{ margin: 0 }}>
        Respostas: {m.aiTurns} pela IA, {m.rulesTurns} pelo robô de regras · Perguntas sem resposta: {data.questions.open} abertas, {data.questions.answered} respondidas no período.
      </p>

      <div className="form-grid cols-2">
        <div>
          <h3>Respostas mal avaliadas</h3>
          {data.badReplies.length === 0 ? <p className="adm-muted">Nenhuma no período.</p> : (
            <ul className="bot-questions">
              {data.badReplies.map((b) => (
                <li key={b.id}>
                  <div className="bot-q-head">
                    <small className="adm-muted">Robô disse:</small>
                    <span className="bot-quote">{b.body.slice(0, 220)}{b.body.length > 220 ? "…" : ""}</span>
                    {b.note && <small><b>Deveria:</b> {b.note}</small>}
                    <small className="adm-muted">{b.ratedBy ? `${b.ratedBy} · ` : ""}{dateTime(b.createdAt)} · <Link to={`/admin/atendimento?c=${b.conversationId}`} style={{ textDecoration: "underline" }}>ver conversa</Link></small>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div>
          <h3>Conversas com problema</h3>
          {data.problems.length === 0 ? <p className="adm-muted">Nenhuma no período.</p> : (
            <ul className="bot-questions">
              {data.problems.map((p) => (
                <li key={p.id}>
                  <div className="bot-q-head">
                    <b>{p.name ?? p.phone}</b>
                    {p.note && <small>{p.note}</small>}
                    <small className="adm-muted">{dateTime(p.reviewedAt)} · <Link to={`/admin/atendimento?c=${p.id}`} style={{ textDecoration: "underline" }}>ver conversa</Link></small>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}

function ProductsTab({ form, products, onChange }: { form: BotConfig; products: Overview["products"]; onChange: (p: BotConfig["products"]) => void }) {
  const [q, setQ] = useState("");
  const list = useMemo(() => products.filter((p) => !q || `${p.name} ${p.sku} ${p.category}`.toLowerCase().includes(q.toLowerCase())), [products, q]);
  const filled = (k?: Knowledge) => !!k && Object.values(k).some((v) => v.trim());
  return (
    <div className="adm-form">
      <p className="adm-muted" style={{ margin: 0 }}>A ficha de cada produto ensina o robô a explicar como ele é feito, com o que combina e como guardar. Escreva como você explicaria no balcão.</p>
      <label className="adm-search"><Icon name="search" className="icon-sm" /><input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Buscar produto" aria-label="Buscar produto" /></label>
      <ul className="bot-products">
        {list.map((p) => {
          const k = form.products[p.sku] ?? emptyKnowledge;
          const upd = (patch: Partial<Knowledge>) => onChange({ ...form.products, [p.sku]: { ...k, ...patch } });
          return (
            <li key={p.sku}>
              <details>
                <summary><span><b>{p.name}</b><small className="adm-muted">{p.sku} · {p.category}</small></span>{filled(form.products[p.sku]) ? <span className="bot-pill ok">Ficha preenchida</span> : <span className="bot-pill">Sem ficha</span>}</summary>
                <div className="form-grid cols-2">
                  <label className="field span-all"><span>Como é feito (leite, coalho, cura, processo)</span><textarea className="input" rows={2} maxLength={800} value={k.fabrication} onChange={(e) => upd({ fabrication: e.target.value })} /></label>
                  <label className="field"><span>Combina com</span><textarea className="input" rows={2} maxLength={500} value={k.pairing} onChange={(e) => upd({ pairing: e.target.value })} placeholder="Vinho, café, goiabada…" /></label>
                  <label className="field"><span>Como guardar</span><textarea className="input" rows={2} maxLength={500} value={k.storage} onChange={(e) => upd({ storage: e.target.value })} placeholder="Geladeira, papel manteiga…" /></label>
                  <label className="field span-all"><span>Observações para a venda</span><textarea className="input" rows={2} maxLength={500} value={k.notes} onChange={(e) => upd({ notes: e.target.value })} placeholder="Ex.: o mais pedido para presente" /></label>
                </div>
              </details>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function QuestionsTab({ onAnswered }: { onAnswered: (o: Overview) => void }) {
  const { toast } = useStore();
  const [status, setStatus] = useState<"open" | "answered" | "ignored">("open");
  const { data, reload } = useApi<{ questions: Question[] }>(`/admin/robo/questions?status=${status}`);
  const [editing, setEditing] = useState<{ id: number; question: string; answer: string; keywords: string[] } | null>(null);

  const answer = async () => {
    if (!editing) return;
    try {
      const o = await api<Overview>(`/admin/robo/questions/${editing.id}/answer`, { body: { question: editing.question, answer: editing.answer, keywords: editing.keywords } });
      onAnswered(o);
      setEditing(null);
      reload();
      toast({ message: "Resposta adicionada ao rascunho. Publique para o robô usar com os clientes." });
    } catch (e) {
      toast({ message: e instanceof ApiError ? (e.details?.[0]?.message ?? e.message) : "Não foi possível salvar", kind: "error" });
    }
  };
  const ignore = async (id: number) => {
    await api(`/admin/robo/questions/${id}/ignore`, { body: {} }).catch(() => toast({ message: "Não foi possível ignorar", kind: "error" }));
    reload();
  };

  return (
    <div className="adm-form">
      <div className="adm-seg" role="group" aria-label="Filtrar perguntas">
        <button aria-pressed={status === "open"} onClick={() => setStatus("open")}>Para responder</button>
        <button aria-pressed={status === "answered"} onClick={() => setStatus("answered")}>Respondidas</button>
        <button aria-pressed={status === "ignored"} onClick={() => setStatus("ignored")}>Ignoradas</button>
      </div>
      {status === "open" && <p className="adm-muted" style={{ margin: 0 }}>Perguntas de clientes que o robô não soube responder. Ao responder, a resposta vira uma pergunta frequente no rascunho.</p>}
      {!data ? <div className="skeleton" style={{ height: 160 }} /> : data.questions.length === 0 ? (
        <div className="adm-empty">{status === "open" ? "Nenhuma pergunta pendente. 🎉" : "Nada por aqui."}</div>
      ) : (
        <ul className="bot-questions">
          {data.questions.map((q) => (
            <li key={q.id}>
              <div className="bot-q-head">
                <b>“{q.question}”</b>
                <small className="adm-muted">
                  {q.times > 1 ? `${q.times} vezes · ` : ""}{q.source === "ia" ? "robô com IA" : "robô de regras"} · {dateTime(q.lastAskedAt)}
                  {q.conversationId && <> · <Link to={`/admin/atendimento?c=${q.conversationId}`} style={{ textDecoration: "underline" }}>ver conversa</Link></>}
                </small>
                {q.answer && <small>Resposta: {q.answer}{q.answeredBy ? ` (${q.answeredBy})` : ""}</small>}
              </div>
              {status === "open" && editing?.id !== q.id && (
                <div className="pay-actions">
                  <button className="btn btn-primary btn-sm" onClick={() => setEditing({ id: q.id, question: q.question, answer: "", keywords: [] })}>Responder e ensinar</button>
                  <button className="btn btn-outline btn-sm" onClick={() => ignore(q.id)}>Ignorar</button>
                </div>
              )}
              {editing?.id === q.id && (
                <div className="bot-faq">
                  <label className="field"><span>Pergunta (como vai ficar salva)</span><input className="input" maxLength={200} value={editing.question} onChange={(e) => setEditing({ ...editing, question: e.target.value })} /></label>
                  <label className="field"><span>Resposta</span><textarea className="input" rows={3} maxLength={1000} autoFocus value={editing.answer} onChange={(e) => setEditing({ ...editing, answer: e.target.value })} /></label>
                  <label className="field"><span>Palavras-chave (separe por vírgula)</span><WordsInput label="Palavras-chave" value={editing.keywords} onChange={(keywords) => setEditing({ ...editing, keywords })} placeholder="cesta, presente personalizado" /></label>
                  <div className="pay-actions">
                    <button className="btn btn-primary btn-sm" onClick={answer} disabled={editing.answer.trim().length < 2 || editing.keywords.length === 0}>Salvar no rascunho</button>
                    <button className="btn btn-outline btn-sm" onClick={() => setEditing(null)}>Cancelar</button>
                  </div>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
