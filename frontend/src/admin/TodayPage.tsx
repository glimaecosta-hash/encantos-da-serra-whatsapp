import { useEffect } from "react";
import { brl, dateTime, longDate, shortDate, STATUS_LABEL } from "../format";
import { Icon, type IconName } from "../icons";
import { Link } from "../router";
import { useApi } from "../store";

// Painel → Hoje: a primeira tela do dia. Cada bloco diz o que fazer e leva direto para onde se faz.

type Today = {
  date: string;
  sales: { orders: number; cents: number };
  separate: { confirmed: number; preparing: number; items: { code: string; status: string; totalCents: number; scheduledDelivery: string | null; customer: string; region: string | null }[] };
  deliveries: { count: number; inTransit: number; items: { code: string; status: string; customer: string; region: string | null }[] };
  payments: { count: number; items: { provider: string; amountCents: number; expiresAt: string; code: string }[] };
  conversations: { count: number; items: { id: number; name: string | null; phoneLabel: string; topic: string; waitingSince: string | null; pendingApproval: number }[] };
  stock: { shortage: number; belowMinimum: number; expiring: number; items: { id: number; name: string; status: string; expiry: string | null; available: number; shortUnits: number; expiredUnits: number; expiringUnits: number }[] };
  questions: { open: number };
};

function Block({ icon, title, count, tone, to, action, children, empty }: {
  icon: IconName; title: string; count: number; tone?: "alert" | "warn"; to: string; action: string; children?: React.ReactNode; empty: string;
}) {
  return (
    <section className="adm-card today-block" data-tone={count ? tone : undefined}>
      <header>
        <span className="adm-kpi-icon"><Icon name={icon} className="icon-sm" /></span>
        <h2>{title}</h2>
        <b className="today-count">{count}</b>
      </header>
      {count ? children : <p className="adm-muted today-empty"><Icon name="checkCircle" className="icon-sm" />{empty}</p>}
      <Link to={to} className="btn btn-outline btn-sm today-action">{action} <Icon name="arrowRight" className="icon-sm" /></Link>
    </section>
  );
}

const stockText = (p: Today["stock"]["items"][number]) =>
  p.status === "falta" ? `faltam ${p.shortUnits} un para pedidos`
    : p.expiry === "vencido" ? `${p.expiredUnits} un vencidas`
    : p.expiry === "vencendo" ? `${p.expiringUnits} un vencendo`
    : p.status === "zerado" ? "zerado" : `só ${p.available} un`;

export function TodayPage() {
  const { data, loading, reload } = useApi<Today>("/admin/today");
  // Atualiza sozinha a cada minuto: a tela fica aberta no balcão.
  useEffect(() => {
    const t = setInterval(reload, 60_000);
    return () => clearInterval(t);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  if (loading && !data) return <div className="skeleton" style={{ height: 480 }} />;
  if (!data) return null;
  const sep = data.separate.confirmed + data.separate.preparing;

  return (
    <>
      <div className="adm-head">
        <div>
          <h1>Hoje</h1>
          <p>{longDate(data.date)} ·{data.sales.orders} {data.sales.orders === 1 ? "pedido" : "pedidos"} hoje ({brl(data.sales.cents)})</p>
        </div>
        <button className="btn btn-outline btn-sm" onClick={reload} disabled={loading}>
          <Icon name={loading ? "loader" : "route"} className={loading ? "icon-sm spin" : "icon-sm"} />Atualizar
        </button>
      </div>

      <div className="today-grid">
        <Block icon="chat" title="Clientes esperando" count={data.conversations.count} tone="alert" to="/admin/atendimento" action="Abrir atendimento" empty="Ninguém esperando resposta.">
          <ul className="today-list">
            {data.conversations.items.map((c) => (
              <li key={c.id}><Link to={`/admin/atendimento?c=${c.id}`}><b>{c.name ?? c.phoneLabel}</b></Link>
                <small>{c.pendingApproval ? `${c.pendingApproval} resposta(s) do robô para aprovar` : c.waitingSince ? `esperando desde ${dateTime(c.waitingSince)}` : "respondeu"}</small></li>
            ))}
          </ul>
        </Block>

        <Block icon="box" title="Pedidos para separar" count={sep} tone="warn" to="/admin/pedidos" action="Ver pedidos e lista de separação" empty="Nada para separar agora.">
          <p className="today-sub">{data.separate.confirmed} pagos aguardando · {data.separate.preparing} em separação</p>
          <ul className="today-list">
            {data.separate.items.map((o) => (
              <li key={o.code}><Link to={`/admin/pedidos?q=${o.code}`}><b>{o.code}</b></Link>
                <small>{o.customer} · {o.region ?? "—"}{o.scheduledDelivery ? ` · rota ${shortDate(o.scheduledDelivery)}` : ""} · {STATUS_LABEL[o.status] ?? o.status}</small></li>
            ))}
          </ul>
        </Block>

        <Block icon="truck" title="Entregas de hoje" count={data.deliveries.count} to="/admin/pedidos" action="Ver pedidos" empty="Nenhuma rota marcada para hoje.">
          <p className="today-sub">{data.deliveries.inTransit} já saíram para entrega</p>
          <ul className="today-list">
            {data.deliveries.items.map((o) => (
              <li key={o.code}><Link to={`/admin/pedidos?q=${o.code}`}><b>{o.code}</b></Link><small>{o.customer} · {o.region ?? "—"} · {STATUS_LABEL[o.status] ?? o.status}</small></li>
            ))}
          </ul>
        </Block>

        <Block icon="dollar" title="Pagamentos em aberto" count={data.payments.count} to="/admin/pedidos" action="Ver pedidos" empty="Nenhum Pix esperando pagamento.">
          <ul className="today-list">
            {data.payments.items.map((p) => (
              <li key={p.code}><Link to={`/admin/pedidos?q=${p.code}`}><b>{p.code}</b></Link><small>{brl(p.amountCents)} · vence {dateTime(p.expiresAt)}</small></li>
            ))}
          </ul>
        </Block>

        <Block icon="boxes" title="Estoque pedindo atenção" count={data.stock.items.length} tone={data.stock.shortage ? "alert" : "warn"} to="/admin/estoque" action="Abrir estoque" empty="Estoque em dia.">
          <p className="today-sub">{data.stock.shortage} faltando para pedidos · {data.stock.belowMinimum} abaixo do mínimo · {data.stock.expiring} com validade perto</p>
          <ul className="today-list">
            {data.stock.items.map((p) => <li key={p.id}><b>{p.name}</b><small>{stockText(p)}</small></li>)}
          </ul>
        </Block>

        <Block icon="sparkle" title="Perguntas para o robô" count={data.questions.open} to="/admin/robo" action="Responder na Central do Robô" empty="O robô soube responder tudo.">
          <p className="today-sub">Clientes perguntaram algo que o robô não sabia. Responda uma vez e ele aprende.</p>
        </Block>
      </div>
    </>
  );
}
