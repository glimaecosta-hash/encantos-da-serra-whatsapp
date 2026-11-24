import { useEffect } from "react";
import { QuickOrder } from "../components/QuickOrder";
import { brl, dateTime, longDate, shortDate, STATUS_LABEL } from "../format";
import { Icon } from "../icons";
import { Link } from "../router";
import { useApi, useStore } from "../store";
import { useWhatsApp, WhatsAppButton } from "../whatsapp";
import { useHome } from "./Home";

type Regions = { regions: { id: number; name: string; cepRange: [string, string]; cutoffDays: number; routes: { date: string; weekday: string }[] }[] };
type Quotes = { quotes: { code: string; status: string; estimatedTotalCents: number; offeredTotalCents: number | null; validUntil: string | null; createdAt: string }[] };

function MyQuotes() {
  const { user } = useStore();
  const isB2B = user?.role === "business" || user?.role === "admin";
  const { data, reload } = useApi<Quotes>(isB2B ? "/wholesale/quotes" : null, [user?.id]);
  useEffect(() => {
    window.addEventListener("quotes:changed", reload);
    return () => window.removeEventListener("quotes:changed", reload);
  }, [reload]);

  return (
    <div className="card" style={{ padding: 24 }} id="cotacoes">
      <h2 style={{ fontSize: 24, marginBottom: 8 }}>Minhas cotações</h2>
      {!isB2B ? (
        <p className="muted">Entre com uma conta de empresa (CNPJ) para pedir e acompanhar cotações. <Link to="/entrar?tipo=empresa&next=/atacado" className="link">Criar conta de empresa</Link></p>
      ) : data?.quotes.length ? (
        <div className="table-wrap">
          <table className="data-table">
            <thead><tr><th>Cotação</th><th>Pedido em</th><th>Status</th><th style={{ textAlign: "right" }}>Estimado</th><th style={{ textAlign: "right" }}>Proposta</th></tr></thead>
            <tbody>
              {data.quotes.map((q) => (
                <tr key={q.code}>
                  <td><b style={{ fontWeight: 600 }}>{q.code}</b></td>
                  <td>{dateTime(q.createdAt)}</td>
                  <td><span className="status" data-status={q.status}>{STATUS_LABEL[q.status]}</span></td>
                  <td style={{ textAlign: "right" }}>{brl(q.estimatedTotalCents)}</td>
                  <td style={{ textAlign: "right" }}>{q.offeredTotalCents ? <>{brl(q.offeredTotalCents)}{q.validUntil && <small className="muted" style={{ display: "block" }}>até {longDate(q.validUntil)}</small>}</> : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : <p className="muted">Nenhuma cotação ainda. Monte seu pedido acima e clique em “Pedir cotação”.</p>}
    </div>
  );
}

function RoutesCalendar() {
  const { data } = useApi<Regions>("/delivery/routes?weeks=3");
  return (
    <div className="card" style={{ padding: 24 }} id="rotas">
      <h2 style={{ fontSize: 24, marginBottom: 8 }}>Dias de entrega por região</h2>
      <p className="muted" style={{ marginTop: 0 }}>O pedido entra na próxima rota, respeitando o prazo de corte da região.</p>
      <div className="table-wrap">
        <table className="data-table">
          <thead><tr><th>Região</th><th>Pedir até</th><th>Próximas entregas</th></tr></thead>
          <tbody>
            {data?.regions.map((r) => (
              <tr key={r.id}>
                <td><b style={{ fontWeight: 600 }}>{r.name}</b><small className="muted" style={{ display: "block" }}>CEP {r.cepRange[0]} a {r.cepRange[1]}</small></td>
                <td className="nowrap">{r.cutoffDays} dia{r.cutoffDays > 1 ? "s" : ""} antes</td>
                <td>{r.routes.slice(0, 4).map((x) => `${x.weekday.split("-")[0]} ${shortDate(x.date)}`).join(" · ")}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// Com a venda pelo WhatsApp, o lugar das "Minhas cotações" vira o passo a passo da negociação.
function NegotiateCard() {
  const wa = useWhatsApp();
  return (
    <div className="card" style={{ padding: 24 }} id="cotacoes">
      <h2 style={{ fontSize: 24, marginBottom: 8 }}>Como negociamos</h2>
      <ol className="wa-steps">
        <li>Monte a lista acima com a quantidade de caixas.</li>
        <li>Clique em <b>Negociar pelo WhatsApp</b>: a lista vai pronta para o nosso comercial.</li>
        <li>Combinamos preço, prazo de pagamento e o dia da rota refrigerada.</li>
        <li>O pedido é registrado e você acompanha cada etapa pelo mesmo número.</li>
      </ol>
      {wa.number && <WhatsAppButton href={wa.link("Olá! Tenho interesse em compra para empresa (atacado).")}>Falar com o comercial</WhatsAppButton>}
      {wa.hours && <p className="muted" style={{ margin: "10px 0 0", fontSize: 14 }}>Atendimento: {wa.hours}</p>}
    </div>
  );
}

export function WholesalePage() {
  const { data } = useHome();
  const wa = useWhatsApp();
  useEffect(() => { document.title = "Atacado para empresas · Encantos da Serra"; }, []);
  return (
    <>
      <div className="container page-head">
        <span className="eyebrow">Atacado</span>
        <h1>Abastecimento para o seu negócio.</h1>
        <p>Preço por faixa de volume para empórios, restaurantes e redes.</p>
        <ul className="perks">
          <li><Icon name="receipt" className="icon-sm" />Nota fiscal em todas as compras</li>
          <li><Icon name="snowflake" className="icon-sm" />Entrega refrigerada programada</li>
          <li><Icon name="headset" className="icon-sm" />Gerente de conta dedicado</li>
        </ul>
      </div>
      <section className="section-tight" id="pedido-rapido" aria-labelledby="pedido-rapido-titulo" style={{ paddingTop: 8 }}>
        <div className="container">
          <h2 id="pedido-rapido-titulo" className="sr-only">Pedido rápido</h2>
          <p className="muted" style={{ margin: "0 0 16px" }}>Ajuste a quantidade de caixas e veja o preço mudar por faixa.{wa.viaWhatsApp ? " Depois é só mandar a lista pelo WhatsApp." : ""}</p>
          <QuickOrder nextRoute={data?.highlights.nextColdShipment} />
        </div>
      </section>
      <section className="section-tight" style={{ paddingBottom: 80 }}>
        <div className="container two-col">
          <RoutesCalendar />
          {wa.viaWhatsApp ? <NegotiateCard /> : <MyQuotes />}
        </div>
      </section>
    </>
  );
}
