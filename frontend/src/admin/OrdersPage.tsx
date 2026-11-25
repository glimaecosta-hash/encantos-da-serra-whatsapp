import { Fragment, useEffect, useState } from "react";
import { api, ApiError } from "../api";
import { brl, dateTime, shortDate, STATUS_LABEL } from "../format";
import { Icon, type IconName } from "../icons";
import { Link, useLocation } from "../router";
import { useApi, useDebounced, useStore } from "../store";
import { Dialog } from "./Dialog";
import { OrderPayment, PaymentSettingsDialog } from "./payments";
import { BulkBar, printPickingList } from "./ordersBulk";
import { NEXT_ACTION, NEXT_MESSAGE, timeAgo, type Board, type BoardOrder, type Coverage } from "./types";

const FILTERS = [
  { id: "open", label: "Abertos" },
  { id: "uncovered", label: "Sem cobertura" },
  { id: "in_transit", label: "Em rota" },
  { id: "delivered", label: "Entregues" },
  { id: "cancelled", label: "Cancelados" },
  { id: "all", label: "Todos" },
] as const;

type FilterId = (typeof FILTERS)[number]["id"];

export function CoverageBadge({ coverage, shortUnits }: { coverage: Coverage | null; shortUnits: number }) {
  if (!coverage) return <span className="adm-muted">—</span>;
  const map: Record<Coverage, { label: string; icon: IconName }> = {
    covered: { label: "Coberto", icon: "checkCircle" },
    partial: { label: `Parcial · faltam ${shortUnits} un`, icon: "clock" },
    uncovered: { label: `Sem estoque · ${shortUnits} un`, icon: "x" },
  };
  const m = map[coverage];
  return <span className="adm-cov" data-cov={coverage}><Icon name={m.icon} className="icon-sm" />{m.label}</span>;
}

function Kpi({ label, value, hint, tone, active, onClick, icon }: { label: string; value: string | number; hint?: string; tone?: "alert" | "ok"; active?: boolean; onClick?: () => void; icon: IconName }) {
  return (
    <button className="adm-kpi" data-tone={tone} aria-pressed={active} onClick={onClick} disabled={!onClick}>
      <span className="adm-kpi-icon"><Icon name={icon} className="icon-sm" /></span>
      <span className="adm-kpi-label">{label}</span>
      <b>{value}</b>
      {hint && <small>{hint}</small>}
    </button>
  );
}

type Pending = { order: BoardOrder; to: string; forced?: boolean; warning?: string };

export function OrdersPage() {
  const { toast } = useStore();

  const { search } = useLocation();
  // Links do Atendimento abrem já filtrando pelo código do pedido (?q=PED-...).
  const [q, setQ] = useState(() => search.get("q") ?? "");
  const [filter, setFilter] = useState<FilterId>(() => (search.get("q") ? "all" : "open"));
  const term = useDebounced(q.trim(), 300);
  const { data, loading, reload } = useApi<Board>(`/admin/orders?filter=${filter}${term ? `&q=${encodeURIComponent(term)}` : ""}`);
  const [expanded, setExpanded] = useState<number | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [message, setMessage] = useState("");
  const [temperature, setTemperature] = useState("4.0");
  const [saving, setSaving] = useState(false);
  const [updatedAt, setUpdatedAt] = useState(new Date());
  const [showPayments, setShowPayments] = useState(false);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  useEffect(() => setSelected(new Set()), [filter, term]);

  useEffect(() => { if (data) setUpdatedAt(new Date()); }, [data]);

  const open = (order: BoardOrder, to: string) => {
    setPending({ order, to });
    setMessage(NEXT_MESSAGE[to] ?? "");
    setTemperature("4.0");
  };

  const confirm = async () => {
    if (!pending) return;
    setSaving(true);
    try {
      const needsTemp = pending.to === "in_transit" || pending.to === "delivered";
      await api(`/admin/orders/${pending.order.code}/events`, {
        body: {
          status: pending.to,
          message: message.trim() || NEXT_MESSAGE[pending.to],
          temperatureC: needsTemp && temperature ? Number(temperature.replace(",", ".")) : undefined,
          force: pending.forced || undefined,
        },
      });
      toast({ message: `${pending.order.code}: ${STATUS_LABEL[pending.to]?.toLowerCase()}.` });
      setPending(null);
      reload();
    } catch (e) {
      if (e instanceof ApiError && e.code === "not_covered") {
        setPending({ ...pending, warning: e.message });
      } else {
        toast({ message: e instanceof ApiError ? e.message : "Não foi possível atualizar", kind: "error" });
      }
    } finally { setSaving(false); }
  };

  const s = data?.summary;
  const orders = data?.orders ?? [];
  const selectedOrders = orders.filter((o) => selected.has(o.id));
  const toggle = (id: number) => setSelected((cur) => { const n = new Set(cur); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const allSelected = orders.length > 0 && orders.every((o) => selected.has(o.id));
  // Lista de separação do dia: pedidos pagos ou em separação (os selecionados, se houver).
  const toPick = orders.filter((o) => o.status === "confirmed" || o.status === "preparing");

  return (
    <>
      <div className="adm-head">
        <div>
          <h1>Pedidos</h1>
          <p>Cobertura calculada sobre o estoque físico, por ordem de chegada: o pedido mais antigo tem prioridade.</p>
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button className="btn btn-outline btn-sm" disabled={!toPick.length} title={toPick.length ? "Pedidos pagos e em separação, agrupados por rota" : "Nenhum pedido para separar neste filtro"}
            onClick={() => { if (!printPickingList(toPick)) toast({ message: "Permita pop-ups para abrir a lista de separação.", kind: "error" }); }}>
            <Icon name="receipt" className="icon-sm" />Lista de separação{toPick.length ? ` (${toPick.length})` : ""}
          </button>
          <button className="btn btn-outline btn-sm" onClick={() => setShowPayments(true)}><Icon name="dollar" className="icon-sm" />Pagamentos</button>
          <button className="btn btn-outline btn-sm" onClick={reload} disabled={loading}>
            <Icon name={loading ? "loader" : "route"} className={loading ? "icon-sm spin" : "icon-sm"} />Atualizar
            <span className="adm-muted" style={{ fontWeight: 400 }}>· {updatedAt.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}</span>
          </button>
        </div>
      </div>
      <PaymentSettingsDialog open={showPayments} onClose={() => setShowPayments(false)} />

      <div className="adm-kpis">
        <Kpi icon="dollar" label="Total de vendas" value={s ? brl(s.salesCents) : "–"}
          hint={s ? `${s.salesOrders} ${s.salesOrders === 1 ? "pedido" : "pedidos"} · ${brl(s.sales30dCents)} nos últimos 30 dias` : undefined} />
        <Kpi icon="receipt" label="Em aberto" value={s?.openOrders ?? "–"} hint={s ? brl(s.openValueCents) : undefined} active={filter === "open"} onClick={() => setFilter("open")} />
        <Kpi icon="box" label="Sem estoque suficiente" value={s?.uncoveredOrders ?? "–"} hint={s?.uncoveredOrders ? "precisam de reposição" : "todos cobertos"} tone={s?.uncoveredOrders ? "alert" : "ok"} active={filter === "uncovered"} onClick={() => setFilter("uncovered")} />
        <Kpi icon="layers" label="Prontos para expedir" value={s?.readyToShip ?? "–"} hint={s?.nextRoute ? `próxima rota ${shortDate(s.nextRoute)}` : undefined} />
        <Kpi icon="truck" label="Em rota" value={s?.inTransit ?? "–"} active={filter === "in_transit"} onClick={() => setFilter("in_transit")} />
      </div>

      <div className="adm-toolbar">
        <div className="adm-seg" role="group" aria-label="Filtrar pedidos">
          {FILTERS.map((f) => (
            <button key={f.id} aria-pressed={filter === f.id} onClick={() => { setFilter(f.id); setExpanded(null); }}>
              {f.label}
              {f.id === "uncovered" && !!s?.uncoveredOrders && <span className="adm-count">{s.uncoveredOrders}</span>}
            </button>
          ))}
        </div>
        <label className="adm-search">
          <Icon name="search" className="icon-sm" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Código, cliente ou empresa" aria-label="Buscar pedidos" />
        </label>
      </div>

      <BulkBar selected={selectedOrders} onClear={() => setSelected(new Set())} onDone={() => { setSelected(new Set()); reload(); }} />

      <div className="adm-card">
        <div className="adm-table-wrap">
          <table className="adm-table">
            <thead>
              <tr>
                <th className="sel-col"><input type="checkbox" aria-label="Selecionar todos" checked={allSelected} onChange={() => setSelected(allSelected ? new Set() : new Set(orders.map((o) => o.id)))} /></th>
                <th>Pedido</th>
                <th>Cliente</th>
                <th>Itens</th>
                <th>Entrega</th>
                <th className="num">Total</th>
                <th>Status</th>
                <th>Estoque</th>
                <th className="actions"><span className="sr-only">Ações</span></th>
              </tr>
            </thead>
            <tbody>
              {loading && !data && (
                <tr><td colSpan={9}><div className="skeleton" style={{ height: 160 }} /></td></tr>
              )}
              {!loading && orders.length === 0 && (
                <tr><td colSpan={9} className="adm-empty">
                  {filter === "uncovered" ? "Nenhum pedido sem cobertura. O estoque físico atende todos os pedidos abertos." : "Nenhum pedido neste filtro."}
                </td></tr>
              )}
              {orders.map((o) => {
                const isOpen = expanded === o.id;
                const next = o.nextStatuses.find((st) => st !== "cancelled");
                return (
                  <Fragment key={o.id}>
                    <tr className="adm-row" data-cov={o.coverage ?? undefined} data-expanded={isOpen} data-selected={selected.has(o.id) || undefined} onClick={() => setExpanded(isOpen ? null : o.id)}>
                      <td className="sel-col" onClick={(e) => e.stopPropagation()}>
                        <input type="checkbox" aria-label={`Selecionar ${o.code}`} checked={selected.has(o.id)} onChange={() => toggle(o.id)} />
                      </td>
                      <td>
                        <button className="adm-expand" aria-expanded={isOpen} aria-label={`Detalhes de ${o.code}`} onClick={(e) => { e.stopPropagation(); setExpanded(isOpen ? null : o.id); }}>
                          <Icon name="arrowRight" className="icon-sm" />
                        </button>
                        <b className="adm-code">{o.code}</b>
                        <small className="adm-muted" title={dateTime(o.createdAt)}>{timeAgo(o.createdAt)}</small>
                      </td>
                      <td>
                        <span className="adm-strong">{o.tradeName ?? o.customerName}</span>
                        <small>
                          <span className="adm-chan" data-chan={o.channel}>{o.channel === "wholesale" ? "Atacado" : "Varejo"}</span>
                          {o.source === "whatsapp" && (
                            o.conversationId
                              ? <Link to={`/admin/atendimento?c=${o.conversationId}`} className="adm-chan" data-chan="whatsapp" onClick={(e) => e.stopPropagation()} title="Abrir a conversa">WhatsApp</Link>
                              : <span className="adm-chan" data-chan="whatsapp">WhatsApp</span>
                          )}
                        </small>
                      </td>
                      <td className="adm-items-cell">
                        {o.items.slice(0, 2).map((it, i) => (
                          <span key={i} className="adm-item-line">
                            {it.mode === "box" ? `${it.quantity} cx` : `${it.quantity} un`} {it.name}
                          </span>
                        ))}
                        {o.items.length > 2 && <small className="adm-muted">+{o.items.length - 2} itens</small>}
                      </td>
                      <td className="nowrap">
                        {o.scheduledDelivery ? shortDate(o.scheduledDelivery) : "—"}
                        <small className="adm-muted">{o.region ?? o.cep}</small>
                        {o.deliveryChangedAt && !o.shippedAt && <small className="adm-changed" title={`Alterada em ${dateTime(o.deliveryChangedAt)}`}>Entrega alterada</small>}
                      </td>
                      <td className="num">{brl(o.totalCents)}</td>
                      <td><span className="status" data-status={o.status}>{STATUS_LABEL[o.status]}</span></td>
                      <td><CoverageBadge coverage={o.coverage} shortUnits={o.shortUnits} /></td>
                      <td className="actions" onClick={(e) => e.stopPropagation()}>
                        {next && (
                          <button className={`btn btn-sm ${next === "in_transit" && o.coverage !== "covered" ? "btn-outline" : "btn-primary"}`} onClick={() => open(o, next)}>
                            {NEXT_ACTION[next]}
                          </button>
                        )}
                      </td>
                    </tr>
                    {isOpen && (
                      <tr className="adm-detail-row">
                        <td colSpan={9}>
                          <OrderDetail order={o} onAction={(to) => open(o, to)} onChanged={reload} />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      <Dialog open={!!pending} onClose={() => setPending(null)} title={pending ? `${NEXT_ACTION[pending.to] ?? "Cancelar"} ${pending.order.code}` : ""}>
        {pending && (
          <div className="adm-form">
            {pending.to === "in_transit" && !pending.warning && (
              <p className="adm-note">A expedição baixa o estoque físico dos itens deste pedido.</p>
            )}
            {pending.to === "cancelled" && (
              <p className="adm-note">{pending.order.shippedAt ? "O pedido já saiu: os itens voltam ao estoque físico como devolução." : "A reserva dos itens é liberada para outros pedidos."}</p>
            )}
            {pending.warning && (
              <div className="adm-alert">
                <Icon name="clock" className="icon-sm" />
                <div>
                  <b>{pending.warning}</b>
                  <span>Expedir agora usa unidades que estavam reservadas para pedidos mais antigos, que passam a ficar sem cobertura.</span>
                </div>
              </div>
            )}
            <label className="field">
              <span>Mensagem na linha do tempo do cliente</span>
              <input className="input" value={message} onChange={(e) => setMessage(e.target.value)} />
            </label>
            {(pending.to === "in_transit" || pending.to === "delivered") && (
              <label className="field">
                <span>Temperatura medida (ºC)</span>
                <input className="input" inputMode="decimal" value={temperature} onChange={(e) => setTemperature(e.target.value)} style={{ maxWidth: 140 }} />
              </label>
            )}
            <div className="adm-form-actions">
              <button className="btn btn-outline btn-sm" onClick={() => setPending(null)}>Voltar</button>
              {pending.warning ? (
                <button className="btn btn-sm adm-btn-danger" disabled={saving} onClick={() => { setPending({ ...pending, forced: true, warning: undefined }); }}>
                  Expedir mesmo assim
                </button>
              ) : (
                <button className={`btn btn-sm ${pending.to === "cancelled" ? "adm-btn-danger" : "btn-primary"}`} disabled={saving || message.trim().length < 3} onClick={confirm}>
                  {saving && <Icon name="loader" className="icon-sm spin" />}
                  {pending.to === "cancelled" ? "Cancelar pedido" : `${NEXT_ACTION[pending.to]}${pending.forced ? " (fora da fila)" : ""}`}
                </button>
              )}
            </div>
          </div>
        )}
      </Dialog>
    </>
  );
}

function OrderDetail({ order: o, onAction, onChanged }: { order: BoardOrder; onAction: (to: string) => void; onChanged: () => void }) {
  return (
    <div className="adm-detail">
      <div>
        <h3>Itens e estoque</h3>
        <ul className="adm-alloc">
          {o.items.map((it, i) => {
            const pct = it.units ? Math.round((it.allocated / it.units) * 100) : 100;
            const showCoverage = o.coverage !== null;
            return (
              <li key={i}>
                {it.imageUrl ? <img src={it.imageUrl} alt="" /> : <span />}
                <div className="adm-alloc-body">
                  <div className="adm-alloc-top">
                    <span><b>{it.name}</b> <small className="adm-muted">{it.sku}</small></span>
                    <span className="nowrap">{it.mode === "box" ? `${it.quantity} cx · ` : ""}{it.units} un</span>
                  </div>
                  {showCoverage ? (
                    <>
                      <div className="adm-bar" data-short={it.short > 0}><span style={{ width: `${pct}%` }} /></div>
                      <small className={it.short ? "adm-warn" : "adm-muted"}>
                        {it.short ? `${it.allocated} un cobertas pelo físico · faltam ${it.short} un` : "Coberto pelo estoque físico"}
                      </small>
                    </>
                  ) : (
                    <small className="adm-muted">{o.shippedAt ? `Baixado do estoque em ${dateTime(o.shippedAt)}` : "Sem reserva ativa"}</small>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
        {o.shortUnits > 0 && (
          <p className="adm-note">
            Para cobrir, registre uma entrada em <Link to="/admin/estoque" style={{ textDecoration: "underline" }}>Estoque</Link> ou cancele um pedido mais antigo.
          </p>
        )}
      </div>
      <div className="adm-detail-side">
        <h3>Cliente e entrega</h3>
        <dl>
          <dt>Cliente</dt><dd>{o.customerName}{o.tradeName ? ` · ${o.tradeName}` : ""}</dd>
          {o.customerEmail && <><dt>E-mail</dt><dd>{o.customerEmail}</dd></>}
          {o.customerPhone && <><dt>WhatsApp</dt><dd><a href={`https://wa.me/${o.customerPhone}`} target="_blank" rel="noreferrer">{o.customerPhone.replace(/^55(\d{2})(\d{4,5})(\d{4})$/, "($1) $2-$3")}</a></dd></>}
          {o.discountCents > 0 && <><dt>Desconto</dt><dd>−{brl(o.discountCents)}</dd></>}
          <dt>Região</dt><dd>{o.region ?? "—"} · CEP {o.cep.replace(/(\d{5})(\d{3})/, "$1-$2")}</dd>
          <dt>Rota prevista</dt><dd>{o.scheduledDelivery ? shortDate(o.scheduledDelivery) : "—"}{o.deliveryChangedAt && <> · <b className="adm-changed-inline">alterada em {dateTime(o.deliveryChangedAt)}</b></>}</dd>
          <dt>Recebido em</dt><dd>{dateTime(o.createdAt)}</dd>
        </dl>
        <OrderPayment code={o.code} status={o.status} hasWhatsApp={!!o.customerPhone} onChanged={onChanged} />
        {o.nextStatuses.includes("cancelled") && (
          <button className="btn btn-sm adm-btn-ghost-danger" onClick={() => onAction("cancelled")}>
            <Icon name="x" className="icon-sm" />Cancelar pedido
          </button>
        )}
      </div>
    </div>
  );
}
