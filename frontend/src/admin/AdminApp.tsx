import { useEffect, useState } from "react";
import { api } from "../api";
import { BrandMark, Icon, type IconName } from "../icons";
import { TodayPage } from "./TodayPage";
import { Link, matchPath, navigate, useLocation } from "../router";
import { useApi, useStore } from "../store";
import { DashboardPage } from "./DashboardPage";
import { InventoryPage } from "./InventoryPage";
import { OrdersPage } from "./OrdersPage";
import { ProductForm } from "./ProductForm";
import { ProductsPage } from "./ProductsPage";
import { RoutesPage } from "./RoutesPage";
import { AttendancePage } from "./AttendancePage";
import { RequestsPage } from "./RequestsPage";
import { SimulatorPage } from "./SimulatorPage";
import { BotPage } from "./BotPage";

type Tab = { to: string; label: string; icon: IconName; badge?: "attention" | "requests" };

// Menu agrupado pelo jeito que o dia acontece: o que fazer hoje, vender, operar, cadastrar e acompanhar.
const GROUPS: { label: string | null; tabs: Tab[] }[] = [
  { label: null, tabs: [{ to: "/admin/hoje", label: "Hoje", icon: "calendar" }] },
  { label: "Vender", tabs: [
    { to: "/admin/atendimento", label: "Atendimento", icon: "chat", badge: "attention" },
    { to: "/admin/pedidos", label: "Pedidos", icon: "receipt" },
  ] },
  { label: "Operação", tabs: [
    { to: "/admin/estoque", label: "Estoque", icon: "boxes" },
    { to: "/admin/rotas", label: "Rotas", icon: "truck" },
  ] },
  { label: "Catálogo", tabs: [
    { to: "/admin/produtos", label: "Produtos", icon: "layers" },
    { to: "/admin/robo", label: "Robô", icon: "sparkle" },
  ] },
  { label: "Gestão", tabs: [
    { to: "/admin/dashboard", label: "Dashboard", icon: "trending" },
    { to: "/admin/solicitacoes", label: "Solicitações", icon: "mail", badge: "requests" },
    { to: "/admin/simulador", label: "Simulador", icon: "phone" },
  ] },
];

const SECTION_TITLE: [string, string][] = [
  ["/admin/hoje", "Hoje"], ["/admin/pedidos", "Pedidos"],
  ["/admin/estoque", "Estoque"], ["/admin/produtos", "Produtos"], ["/admin/rotas", "Rotas"], ["/admin/dashboard", "Dashboard"],
  ["/admin/atendimento", "Atendimento"], ["/admin/solicitacoes", "Solicitações"], ["/admin/robo", "Central do Robô"], ["/admin/simulador", "Simulador"],
];

// "/admin" abre o Hoje; links antigos de pedido ("/admin?q=PED-…") continuam abrindo Pedidos.
const isOrders = (pathname: string, search: URLSearchParams) => pathname.startsWith("/admin/pedidos") || (pathname === "/admin" && search.has("q"));
const isToday = (pathname: string, search: URLSearchParams) => pathname.startsWith("/admin/hoje") || (pathname === "/admin" && !search.has("q"));

// Contadores das abas (fila do WhatsApp e solicitações do site), atualizados a cada 20 s.
function useBadges(enabled: boolean) {
  const [badges, setBadges] = useState<{ attention: number; requests: number }>({ attention: 0, requests: 0 });
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    const load = async () => {
      try {
        const [att, dash] = await Promise.all([
          api<{ counts: { attention: number } }>("/admin/atendimento?view=attention"),
          api<{ summary: { openQuotes: number; proposalsToReview: number; unreadMessages: number } }>("/admin/dashboard"),
        ]);
        if (alive) setBadges({ attention: att.counts.attention, requests: dash.summary.openQuotes + dash.summary.proposalsToReview + dash.summary.unreadMessages });
      } catch { /* sem sessão */ }
    };
    load();
    const t = setInterval(load, 20000);
    return () => { alive = false; clearInterval(t); };
  }, [enabled]);
  return badges;
}

function Section({ pathname, search }: { pathname: string; search: URLSearchParams }) {
  if (isToday(pathname, search)) return <TodayPage />;
  if (isOrders(pathname, search)) return <OrdersPage />;
  if (pathname === "/admin/produtos/novo") return <ProductForm id={null} />;
  const edit = matchPath("/admin/produtos/:id", pathname);
  if (edit) return <ProductForm key={edit.id} id={Number(edit.id)} />;
  if (pathname.startsWith("/admin/produtos")) return <ProductsPage />;
  if (pathname.startsWith("/admin/estoque")) return <InventoryPage />;
  if (pathname.startsWith("/admin/rotas")) return <RoutesPage />;
  if (pathname.startsWith("/admin/dashboard")) return <DashboardPage />;
  if (pathname.startsWith("/admin/atendimento")) return <AttendancePage />;
  if (pathname.startsWith("/admin/solicitacoes")) return <RequestsPage />;
  if (pathname.startsWith("/admin/simulador")) return <SimulatorPage />;
  if (pathname.startsWith("/admin/robo")) return <BotPage />;
  return <TodayPage />;
}

export function AdminApp() {
  const { pathname, search } = useLocation();
  const { user, ready, logout } = useStore();
  // Enquanto o acesso não estiver configurado, o backend pode liberar o painel (ADMIN_AUTH_DISABLED).
  const access = useApi<{ open: boolean }>("/admin/access");
  const isOpen = access.data?.open ?? false;
  const badges = useBadges(isOpen || user?.role === "admin");

  useEffect(() => {
    if (pathname.startsWith("/admin/produtos/")) return; // o formulário define o próprio título
    const section = isOrders(pathname, search) ? "Pedidos" : SECTION_TITLE.find(([p]) => pathname.startsWith(p))?.[1] ?? "Hoje";
    document.title = `${section} · Painel Encantos`;
  }, [pathname, search]);

  if (!ready || access.loading) return <div className="adm-loading"><Icon name="loader" className="icon spin" /></div>;

  if (!isOpen && (!user || user.role !== "admin")) {
    return (
      <div className="adm-guard">
        <span className="brand-mark"><BrandMark /></span>
        <h1>Painel restrito</h1>
        <p>{user ? "Sua conta não tem acesso de administrador." : "Entre com uma conta de administrador para ver pedidos e estoque."}</p>
        <div style={{ display: "flex", gap: 10, justifyContent: "center", flexWrap: "wrap" }}>
          {!user && <Link to="/entrar?next=/admin" className="btn btn-primary">Entrar</Link>}
          <Link to="/" className="btn btn-outline">Voltar à loja</Link>
        </div>
      </div>
    );
  }

  return (
    <div className="adm">
      <header className="adm-top">
        <div className="adm-wrap adm-top-row">
          <Link to="/admin" className="adm-brand">
            <span className="brand-mark"><BrandMark size={18} /></span>
            <span>Encantos <small>Painel</small></span>
          </Link>
          <nav className="adm-tabs" aria-label="Seções do painel">
            {GROUPS.map((g) => (
              <div key={g.label ?? "hoje"} className="adm-tab-group" role="group" aria-label={g.label ?? "Hoje"}>
                {g.label && <span className="adm-tab-group-label" aria-hidden="true">{g.label}</span>}
                <div className="adm-tab-group-items">
                  {g.tabs.map((t) => {
                    const active = t.to === "/admin/hoje" ? isToday(pathname, search) : t.to === "/admin/pedidos" ? isOrders(pathname, search) : pathname.startsWith(t.to);
                    return (
                      <Link key={t.to} to={t.to} className="adm-tab" aria-current={active ? "page" : undefined} title={t.label}>
                        <Icon name={t.icon} className="icon-sm" /><span className="adm-tab-label">{t.label}</span>
                        {t.badge && badges[t.badge] > 0 && <span className="adm-count adm-tab-badge" aria-label={`${badges[t.badge]} pendentes`}>{badges[t.badge]}</span>}
                      </Link>
                    );
                  })}
                </div>
              </div>
            ))}
          </nav>
          <div className="adm-user">
            <Link to="/" className="adm-link"><Icon name="store" className="icon-sm" /><span>Ver loja</span></Link>
            {isOpen && <span className="adm-open-pill" title="ADMIN_AUTH_DISABLED=true no backend/.env">Acesso livre</span>}
            {user && (
              <>
                <span className="adm-avatar" title={user.email}>{user.name.slice(0, 1)}</span>
                <button className="adm-icon-btn on-dark" aria-label="Sair" onClick={() => { logout(); navigate("/"); }}><Icon name="logout" className="icon-sm" /></button>
              </>
            )}
          </div>
        </div>
      </header>
      <main className="adm-wrap adm-main">
        <Section pathname={pathname} search={search} />
      </main>
    </div>
  );
}
