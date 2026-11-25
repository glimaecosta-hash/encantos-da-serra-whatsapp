import { useMemo, useState } from "react";
import { ApiError, type Product, type ProductList } from "../api";
import { brl } from "../format";
import { Icon } from "../icons";
import { Link } from "../router";
import { useApi, useStore } from "../store";

// "Leve junto": mais vendidos que ainda não estão no carrinho, de preferência de outras linhas
// (doce de leite para quem levou queijo, manteiga para quem levou doce…). Aumenta o pedido sem empurrar.
export function useSuggestions(limit: number) {
  const { cart } = useStore();
  const { data } = useApi<ProductList>("/products?sort=best_sellers&pageSize=16");
  return useMemo(() => {
    const items = data?.items ?? [];
    const inCart = new Set(cart?.lines.map((l) => l.product.id) ?? []);
    const cartCategories = new Set(items.filter((p) => inCart.has(p.id)).map((p) => p.category.slug));
    const candidates = items.filter((p) => !inCart.has(p.id) && p.stock.available);
    const otherLines = candidates.filter((p) => !cartCategories.has(p.category.slug));
    return [...otherLines, ...candidates.filter((p) => cartCategories.has(p.category.slug))].slice(0, limit);
  }, [data, cart, limit]);
}

function SuggestCard({ p }: { p: Product }) {
  const { addToCart, toast } = useStore();
  const [busy, setBusy] = useState(false);
  const add = async () => {
    setBusy(true);
    try {
      await addToCart(p.id, "unit");
      toast({ message: `${p.name} no carrinho.` });
    } catch (e) {
      toast({ message: e instanceof ApiError ? e.message : "Não foi possível adicionar", kind: "error" });
    } finally { setBusy(false); }
  };
  return (
    <li className="suggest-card">
      <Link to={`/produtos/${p.slug}`} className="suggest-img" tabIndex={-1} aria-hidden="true">{p.imageUrl && <img src={p.imageUrl} alt="" loading="lazy" />}</Link>
      <span className="suggest-body">
        <Link to={`/produtos/${p.slug}`} className="suggest-name">{p.name}</Link>
        <small>{brl(p.retail.priceCents)} {p.retail.priceLabel}</small>
      </span>
      <button className="suggest-add" onClick={add} disabled={busy} aria-label={`Adicionar ${p.name} ao carrinho`}>
        <Icon name={busy ? "loader" : "plus"} className={busy ? "icon-sm spin" : "icon-sm"} />
      </button>
    </li>
  );
}

export function LeveJunto({ limit = 4, compact = false, title = "Leve junto" }: { limit?: number; compact?: boolean; title?: string }) {
  const items = useSuggestions(limit);
  if (!items.length) return null;
  return (
    <section className={`suggest ${compact ? "compact" : ""}`} aria-label={title}>
      <h3>{title}</h3>
      <ul className="suggest-list">{items.map((p) => <SuggestCard key={p.id} p={p} />)}</ul>
    </section>
  );
}
