import { useEffect, useMemo, useState } from "react";
import { api, ApiError } from "../api";
import { Icon } from "../icons";
import { useStore } from "../store";
import { Dialog } from "./Dialog";
import { STOCK_LABEL, type Inventory, type InventoryProduct } from "./types";

// Estoque sem uma janela por produto: contagem da câmara fria e entrada de coleta em lote,
// planilha (CSV) e folha de contagem para imprimir.

type Row = InventoryProduct;
type Kind = "contagem" | "entrada";

export function BatchDialog({ kind, products, onClose, onSaved }: { kind: Kind | null; products: Row[]; onClose: () => void; onSaved: (inv: Inventory) => void }) {
  const { toast } = useStore();
  const producers = useMemo(() => [...new Map(products.map((p) => [p.producerId, p.producerName])).entries()].sort((a, b) => a[1].localeCompare(b[1])), [products]);
  const [producer, setProducer] = useState<string>("");
  const [qty, setQty] = useState<Record<number, string>>({});
  const [unit, setUnit] = useState<Record<number, "unit" | "box">>({});
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => { if (kind) { setQty({}); setUnit({}); setNote(""); setProducer(""); } }, [kind]);

  // Coleta é por produtor (o que chegou de cada fazenda); contagem é de tudo.
  const list = kind === "entrada" ? products.filter((p) => String(p.producerId) === producer) : products;
  const filled = list.filter((p) => qty[p.id] !== undefined && qty[p.id] !== "");
  const unitOf = (p: Row) => unit[p.id] ?? (kind === "entrada" && p.boxSize > 1 ? "box" : "unit");
  const unitsOf = (p: Row) => (Number(qty[p.id]) || 0) * (unitOf(p) === "box" ? p.boxSize : 1);

  const save = async () => {
    setSaving(true);
    try {
      const res = await api<Inventory & { changed: number }>("/admin/inventory/batch", {
        body: { kind, note: note.trim() || undefined, items: filled.map((p) => ({ productId: p.id, quantity: Number(qty[p.id]) || 0, unit: unitOf(p) })) },
      });
      onSaved(res);
      toast({ message: kind === "contagem" ? `Contagem registrada: ${filled.length} produtos conferidos, ${res.changed} com diferença ajustada.` : `Entrada registrada em ${res.changed} produtos.` });
      onClose();
    } catch (e) {
      toast({ message: e instanceof ApiError ? e.message : "Não foi possível registrar", kind: "error" });
    } finally { setSaving(false); }
  };

  return (
    <Dialog open={!!kind} onClose={onClose} title={kind === "contagem" ? "Contagem da câmara fria" : "Entrada de coleta"} wide>
      {kind && (
        <div className="adm-form">
          <p className="adm-muted" style={{ margin: 0 }}>
            {kind === "contagem"
              ? "Digite o total que você contou de cada produto. Só os preenchidos são registrados; a diferença vira ajuste no estoque."
              : "Escolha o produtor e digite o que chegou. Cada entrada cria um lote com a validade do produto."}
          </p>
          {kind === "entrada" && (
            <label className="field"><span>Produtor</span>
              <select className="input" value={producer} onChange={(e) => { setProducer(e.target.value); setQty({}); }}>
                <option value="">Escolha…</option>
                {producers.map(([id, name]) => <option key={String(id)} value={String(id)}>{name}</option>)}
              </select>
            </label>
          )}
          {(kind === "contagem" || producer) && (
            <div className="adm-table-wrap batch-wrap">
              <table className="adm-table batch-table">
                <thead><tr><th>Produto</th><th className="num">No sistema</th><th>{kind === "contagem" ? "Contei" : "Chegou"}</th><th className="num">{kind === "contagem" ? "Diferença" : "Físico depois"}</th></tr></thead>
                <tbody>
                  {list.map((p) => {
                    const has = qty[p.id] !== undefined && qty[p.id] !== "";
                    const diff = kind === "contagem" ? unitsOf(p) - p.onHand : p.onHand + unitsOf(p);
                    return (
                      <tr key={p.id} data-filled={has || undefined}>
                        <td><span className="adm-strong">{p.name}</span><small className="adm-muted">{p.sku}</small></td>
                        <td className="num">{p.onHand} un</td>
                        <td>
                          <span className="batch-input">
                            <input className="input" inputMode="numeric" value={qty[p.id] ?? ""} placeholder="—" aria-label={`Quantidade de ${p.name}`}
                              onChange={(e) => setQty((q) => ({ ...q, [p.id]: e.target.value.replace(/\D/g, "") }))} />
                            {p.boxSize > 1 && (
                              <select className="input" value={unitOf(p)} aria-label={`Unidade de ${p.name}`} onChange={(e) => setUnit((u) => ({ ...u, [p.id]: e.target.value as "unit" | "box" }))}>
                                <option value="unit">un</option><option value="box">cx ({p.boxSize})</option>
                              </select>
                            )}
                          </span>
                        </td>
                        <td className="num">{has ? (kind === "contagem" ? <b className={diff < 0 ? "adm-neg" : undefined}>{diff > 0 ? "+" : ""}{diff} un</b> : `${diff} un`) : "—"}</td>
                      </tr>
                    );
                  })}
                  {list.length === 0 && <tr><td colSpan={4} className="adm-empty">Nenhum produto.</td></tr>}
                </tbody>
              </table>
            </div>
          )}
          <label className="field"><span>Observação</span>
            <input className="input" value={note} onChange={(e) => setNote(e.target.value)} placeholder={kind === "contagem" ? "Ex.: contagem de sexta" : "Ex.: coleta de terça, nota 1234"} />
          </label>
          <div className="adm-form-actions">
            <span className="adm-muted">{filled.length} {filled.length === 1 ? "produto preenchido" : "produtos preenchidos"}</span>
            <button className="btn btn-outline btn-sm" onClick={onClose}>Cancelar</button>
            <button className="btn btn-primary btn-sm" onClick={save} disabled={saving || !filled.length}>{saving && <Icon name="loader" className="icon-sm spin" />}Registrar {kind === "contagem" ? "contagem" : "entrada"}</button>
          </div>
        </div>
      )}
    </Dialog>
  );
}

const csvCell = (v: unknown) => {
  const s = v === null || v === undefined ? "" : String(v);
  return /[";\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

// Planilha para Excel (separador ";" e BOM para os acentos abrirem certo).
export function exportInventoryCsv(products: Row[]) {
  const head = ["SKU", "Produto", "Produtor", "Categoria", "Físico (un)", "Reservado (un)", "Disponível (un)", "Mínimo (un)", "Situação", "Vencidas (un)", "Vencendo (un)", "No site"];
  const rows = products.map((p) => [p.sku, p.name, p.producerName, p.categoryName ?? "", p.onHand, p.reserved, p.available, p.minStockUnits, STOCK_LABEL[p.status], p.expiredUnits, p.expiringUnits, p.active ? "sim" : "pausado"]);
  const csv = "﻿" + [head, ...rows].map((r) => r.map(csvCell).join(";")).join("\r\n");
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = `estoque-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));

// Folha para levar à câmara fria: o sistema não mostra o saldo, para a contagem ser às cegas.
export function printCountSheet(products: Row[]) {
  const w = window.open("", "_blank");
  if (!w) return false;
  const rows = [...products].sort((a, b) => a.producerName.localeCompare(b.producerName) || a.name.localeCompare(b.name))
    .map((p) => `<tr><td>${esc(p.producerName)}</td><td>${esc(p.name)}</td><td>${esc(p.sku)}</td><td>${p.boxSize > 1 ? `cx com ${p.boxSize}` : "un"}</td><td class="blank"></td><td class="blank"></td></tr>`).join("");
  w.document.write(`<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>Folha de contagem</title>
    <style>body{font:13px/1.4 system-ui,sans-serif;margin:24px;color:#222}h1{font-size:18px;margin:0}table{width:100%;border-collapse:collapse;margin-top:12px}
    th,td{border:1px solid #bbb;padding:6px;text-align:left}.blank{width:90px}@media print{button{display:none}}</style></head><body>
    <h1>Folha de contagem — câmara fria</h1><p>Data: ____/____/______ · Responsável: ______________________</p>
    <button onclick="print()">Imprimir</button>
    <table><thead><tr><th>Produtor</th><th>Produto</th><th>SKU</th><th>Embalagem</th><th>Contado</th><th>Obs.</th></tr></thead><tbody>${rows}</tbody></table>
    <p>Depois, lance os números em Estoque → Contagem em lote.</p></body></html>`);
  w.document.close();
  return true;
}
