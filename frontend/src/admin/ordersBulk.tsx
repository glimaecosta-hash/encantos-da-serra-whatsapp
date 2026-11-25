import { useState } from "react";
import { api, ApiError } from "../api";
import { brl, shortDate, STATUS_LABEL } from "../format";
import { Icon } from "../icons";
import { useStore } from "../store";
import { Dialog } from "./Dialog";
import { NEXT_ACTION, NEXT_MESSAGE, type BoardOrder } from "./types";

// Pedidos em massa: avançar vários de uma vez e imprimir a lista de separação por rota.

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));

// Lista de separação: por rota (dia + região), o total de cada produto e o que vai em cada pedido.
export function printPickingList(orders: BoardOrder[]) {
  const groups = new Map<string, BoardOrder[]>();
  for (const o of orders) {
    const key = `${o.scheduledDelivery ? shortDate(o.scheduledDelivery) : "Sem data"} · ${o.region ?? "Sem região"}`;
    groups.set(key, [...(groups.get(key) ?? []), o]);
  }
  const sections = [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([route, list]) => {
    const totals = new Map<string, { name: string; sku: string; units: number }>();
    for (const o of list) for (const it of o.items) {
      const t = totals.get(it.sku) ?? { name: it.name, sku: it.sku, units: 0 };
      t.units += it.units;
      totals.set(it.sku, t);
    }
    const totalRows = [...totals.values()].sort((a, b) => a.name.localeCompare(b.name))
      .map((t) => `<tr><td class="box">☐</td><td>${esc(t.name)}</td><td>${esc(t.sku)}</td><td class="n">${t.units} un</td></tr>`).join("");
    const orderBlocks = list.map((o) => `
      <div class="order">
        <h3>☐ ${esc(o.code)} · ${esc(o.tradeName ?? o.customerName)} <small>${esc(STATUS_LABEL[o.status] ?? o.status)} · ${brl(o.totalCents)}</small></h3>
        <ul>${o.items.map((it) => `<li>☐ ${it.mode === "box" ? `${it.quantity} cx (${it.units} un)` : `${it.units} un`} — ${esc(it.name)}</li>`).join("")}</ul>
      </div>`).join("");
    return `<section><h2>Rota ${esc(route)} — ${list.length} ${list.length === 1 ? "pedido" : "pedidos"}</h2>
      <table><thead><tr><th></th><th>Produto</th><th>SKU</th><th class="n">Separar</th></tr></thead><tbody>${totalRows}</tbody></table>${orderBlocks}</section>`;
  }).join("");
  const w = window.open("", "_blank");
  if (!w) return false;
  w.document.write(`<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>Lista de separação</title>
    <style>
      body { font: 14px/1.4 system-ui, sans-serif; color: #222; margin: 24px; }
      h1 { font-size: 20px; margin: 0 0 4px; } h2 { font-size: 16px; margin: 24px 0 8px; border-bottom: 2px solid #222; padding-bottom: 4px; }
      h3 { font-size: 14px; margin: 12px 0 4px; } h3 small { font-weight: 400; color: #666; }
      table { width: 100%; border-collapse: collapse; } th, td { text-align: left; padding: 4px 6px; border-bottom: 1px solid #ddd; }
      .n { text-align: right; white-space: nowrap; } .box { width: 20px; } ul { margin: 0; padding-left: 18px; list-style: none; }
      section { page-break-inside: avoid; } .order { page-break-inside: avoid; } @media print { button { display: none; } }
    </style></head><body>
    <h1>Lista de separação — Encantos da Serra</h1><p>Impressa em ${new Date().toLocaleString("pt-BR")} · ${orders.length} pedidos</p>
    <button onclick="print()">Imprimir</button>${sections}</body></html>`);
  w.document.close();
  return true;
}

// Barra que aparece ao selecionar pedidos: só mostra ações que valem para todos os selecionados.
export function BulkBar({ selected, onClear, onDone }: { selected: BoardOrder[]; onClear: () => void; onDone: () => void }) {
  const { toast } = useStore();
  const [to, setTo] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [saving, setSaving] = useState(false);
  if (!selected.length) return null;

  const common = ["preparing", "in_transit", "delivered"].filter((st) => selected.every((o) => o.nextStatuses.includes(st)));
  const run = async () => {
    if (!to) return;
    setSaving(true);
    try {
      const { results } = await api<{ results: { code: string; ok: boolean; error?: string }[] }>("/admin/orders/bulk-events", {
        body: { codes: selected.map((o) => o.code), status: to, message: message.trim() || NEXT_MESSAGE[to] },
      });
      const failed = results.filter((r) => !r.ok);
      toast(failed.length
        ? { message: `${results.length - failed.length} atualizados. Não deu em ${failed.map((f) => `${f.code} (${f.error})`).join("; ")}`, kind: "error" }
        : { message: `${results.length} pedidos: ${STATUS_LABEL[to]?.toLowerCase()}. Os clientes foram avisados.` });
      setTo(null);
      onDone();
    } catch (e) {
      toast({ message: e instanceof ApiError ? e.message : "Não foi possível atualizar", kind: "error" });
    } finally { setSaving(false); }
  };

  return (
    <>
      <div className="bulk-bar" role="region" aria-label="Pedidos selecionados">
        <b>{selected.length} {selected.length === 1 ? "pedido selecionado" : "pedidos selecionados"}</b>
        {common.map((st) => (
          <button key={st} className="btn btn-primary btn-sm" onClick={() => { setTo(st); setMessage(NEXT_MESSAGE[st] ?? ""); }}>{NEXT_ACTION[st]}</button>
        ))}
        {common.length === 0 && <small>Os selecionados estão em etapas diferentes: escolha pedidos na mesma etapa para avançar juntos.</small>}
        <button className="btn btn-outline btn-sm" onClick={() => { if (!printPickingList(selected)) toast({ message: "Permita pop-ups para abrir a lista de separação.", kind: "error" }); }}>
          <Icon name="receipt" className="icon-sm" />Lista de separação
        </button>
        <button className="btn-link" onClick={onClear}>Limpar seleção</button>
      </div>
      <Dialog open={!!to} onClose={() => setTo(null)} title={to ? `${NEXT_ACTION[to]}: ${selected.length} pedidos` : ""}>
        {to && (
          <div className="adm-form">
            {to === "in_transit" && <p className="adm-note">A expedição baixa o estoque físico de cada pedido. Pedidos sem cobertura completa ficam de fora e aparecem no aviso.</p>}
            <p className="adm-muted" style={{ margin: 0 }}>{selected.map((o) => o.code).join(", ")}</p>
            <label className="field"><span>Mensagem para os clientes</span><input className="input" value={message} onChange={(e) => setMessage(e.target.value)} /></label>
            <div className="adm-form-actions">
              <button className="btn btn-outline btn-sm" onClick={() => setTo(null)}>Voltar</button>
              <button className="btn btn-primary btn-sm" onClick={run} disabled={saving || message.trim().length < 3}>{saving && <Icon name="loader" className="icon-sm spin" />}{NEXT_ACTION[to]} todos</button>
            </div>
          </div>
        )}
      </Dialog>
    </>
  );
}
