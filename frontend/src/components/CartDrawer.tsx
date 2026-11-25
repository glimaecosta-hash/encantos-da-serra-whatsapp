import { useEffect, useRef } from "react";
import type { CartLine } from "../api";
import { brl } from "../format";
import { Icon } from "../icons";
import { Link, navigate, useLocation } from "../router";
import { useStore } from "../store";
import { cartMessage, useWhatsApp, WhatsAppButton } from "../whatsapp";
import { Stepper } from "./Chrome";
import { LeveJunto } from "./Suggestions";

export const lineDetail = (l: CartLine) =>
  l.mode === "box" ? `${l.product.boxLabel} · ${l.units} un a ${brl(l.unitPriceCents)}` : `${brl(l.unitPriceCents)} por ${l.product.unitLabel}`;

// Carrinho lateral: abre ao adicionar um produto, para o cliente ver na hora o que juntou
// e decidir entre continuar escolhendo ou finalizar.
export function CartDrawer() {
  const { cart, cartCount, cartOpen, setCartOpen, setCartQty } = useStore();
  const wa = useWhatsApp();
  const { pathname } = useLocation();
  const closeBtn = useRef<HTMLButtonElement>(null);
  const lastFocus = useRef<Element | null>(null);

  useEffect(() => setCartOpen(false), [pathname]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!cartOpen) return;
    lastFocus.current = document.activeElement;
    closeBtn.current?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setCartOpen(false); };
    document.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
      (lastFocus.current as HTMLElement | null)?.focus?.();
    };
  }, [cartOpen, setCartOpen]);

  if (!cartOpen) return null;
  const lines = cart?.lines ?? [];
  const subtotal = cart?.totals.subtotalCents ?? 0;

  return (
    <div className="drawer-backdrop" onClick={() => setCartOpen(false)}>
      <aside className="drawer" role="dialog" aria-modal="true" aria-labelledby="drawer-title" onClick={(e) => e.stopPropagation()}>
        <header className="drawer-head">
          <h2 id="drawer-title">Seu carrinho {cartCount > 0 && <small>({cartCount} {cartCount === 1 ? "item" : "itens"})</small>}</h2>
          <button ref={closeBtn} className="drawer-close" aria-label="Fechar carrinho" onClick={() => setCartOpen(false)}><Icon name="x" /></button>
        </header>

        {lines.length === 0 ? (
          <div className="drawer-empty">
            <Icon name="cart" />
            <p>Seu carrinho está vazio.</p>
            <button className="btn btn-outline" onClick={() => { setCartOpen(false); navigate("/produtos"); }}>Ver produtos</button>
          </div>
        ) : (
          <>
            <ul className="drawer-lines">
              {lines.map((l) => (
                <li key={l.itemId}>
                  {l.product.imageUrl ? <img src={l.product.imageUrl} alt="" /> : <span className="drawer-img" />}
                  <div>
                    <Link to={`/produtos/${l.product.slug}`} className="drawer-name">{l.product.name}</Link>
                    <small>{lineDetail(l)}</small>
                    {l.issue && <small className="drawer-issue">Disponível: {l.availableUnits} un</small>}
                    <span className="drawer-row">
                      <Stepper value={l.quantity} min={1} onChange={(v) => setCartQty(l.product.id, l.mode, v)} label={`Quantidade de ${l.product.name}`} />
                      <button className="remove-btn" aria-label={`Remover ${l.product.name}`} onClick={() => setCartQty(l.product.id, l.mode, 0)}><Icon name="trash" className="icon-sm" /></button>
                    </span>
                  </div>
                  <b className="drawer-price">{brl(l.totalCents)}</b>
                </li>
              ))}
            </ul>
            <div className="drawer-suggest"><LeveJunto limit={2} compact title="Combina com o seu pedido" /></div>

            <footer className="drawer-foot">
              <div className="summary-row total"><span>Subtotal</span><b>{brl(subtotal)}</b></div>
              <small className="muted">Frete refrigerado calculado pelo CEP{wa.viaWhatsApp ? " no carrinho ou na conversa" : ""}.</small>
              {wa.viaWhatsApp ? (
                <WhatsAppButton className="btn-lg btn-block" href={cart ? wa.link(cartMessage(cart)) : "#"} disabled={!wa.number || !!cart?.hasIssues}>
                  Finalizar pelo WhatsApp
                </WhatsAppButton>
              ) : (
                <Link to="/carrinho" className="btn btn-primary btn-lg btn-block">Finalizar compra <Icon name="arrowRight" className="icon-sm" /></Link>
              )}
              <div className="drawer-links">
                <button className="btn btn-outline" onClick={() => setCartOpen(false)}>Continuar comprando</button>
                {wa.viaWhatsApp && <Link to="/carrinho" className="btn btn-outline">Ver carrinho e frete</Link>}
              </div>
            </footer>
          </>
        )}
      </aside>
    </div>
  );
}

// Barra fixa no celular: lembra o carrinho enquanto o cliente navega.
export function CartBar() {
  const { cart, cartCount, cartOpen, setCartOpen } = useStore();
  const { pathname } = useLocation();
  if (!cartCount || cartOpen || pathname === "/carrinho") return null;
  return (
    <button className="cart-bar" onClick={() => setCartOpen(true)}>
      <span className="cart-bar-count"><Icon name="cart" className="icon-sm" />{cartCount} {cartCount === 1 ? "item" : "itens"}</span>
      <b>{brl(cart?.totals.subtotalCents ?? 0)}</b>
      <span className="cart-bar-cta">Ver carrinho <Icon name="arrowRight" className="icon-sm" /></span>
    </button>
  );
}
