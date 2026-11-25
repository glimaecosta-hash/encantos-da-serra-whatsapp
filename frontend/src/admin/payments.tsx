import { useEffect, useState } from "react";
import { api, ApiError } from "../api";
import { brl, dateTime } from "../format";
import { Icon } from "../icons";
import { useApi, useStore } from "../store";
import { Dialog } from "./Dialog";

// Pagamentos no painel: escolha do provedor, Pix da loja, prazos, e o pagamento de cada pedido.

type ProviderId = "manual_pix" | "mercadopago" | "asaas" | "efi";
type Settings = { provider: ProviderId; cardLink: boolean; pixKey: string; merchantName: string; merchantCity: string; expiresMinutes: number; reminderMinutes: number };
type Overview = {
  settings: Settings;
  providers: { id: ProviderId; label: string; automatic: boolean; needsDocument: boolean; missing: string[]; active: boolean }[];
  webhooks: { publicUrl: string | null; mercadopago: string | null; asaas: string | null };
};

export function PaymentSettingsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { toast } = useStore();
  const { data, setData } = useApi<Overview>(open ? "/admin/pagamentos/settings" : null);
  const [form, setForm] = useState<Settings | null>(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => { if (data) setForm(data.settings); }, [data]);

  const save = async () => {
    if (!form) return;
    setSaving(true);
    try {
      setData(await api<Overview>("/admin/pagamentos/settings", { method: "PUT", body: form }));
      toast({ message: "Pagamentos salvos. Os próximos pedidos já usam esta configuração." });
      onClose();
    } catch (e) {
      toast({ message: e instanceof ApiError ? (e.details?.[0]?.message ?? e.message) : "Não foi possível salvar", kind: "error" });
    } finally { setSaving(false); }
  };

  const chosen = data?.providers.find((p) => p.id === form?.provider);
  const set = <K extends keyof Settings>(k: K, v: Settings[K]) => setForm((f) => (f ? { ...f, [k]: v } : f));

  return (
    <Dialog open={open} onClose={onClose} title="Pagamentos" wide>
      {!form || !data ? <div className="skeleton" style={{ height: 320 }} /> : (
        <div className="adm-form">
          <fieldset className="pay-providers">
            <legend>Como o cliente paga</legend>
            {data.providers.map((p) => (
              <label key={p.id} className="pay-provider" data-active={form.provider === p.id}>
                <input type="radio" name="provider" checked={form.provider === p.id} onChange={() => set("provider", p.id)} />
                <span>
                  <b>{p.label}</b>
                  <small className="adm-muted">
                    {p.automatic ? "Confirma o pagamento sozinho." : "A equipe confere e confirma em Pedidos."}
                    {p.needsDocument ? " Pede o CPF do cliente." : ""}
                  </small>
                  {p.missing.length > 0 && <small className="adm-warn">Falta configurar: {p.missing.join(", ")}</small>}
                </span>
              </label>
            ))}
          </fieldset>

          {chosen && chosen.missing.length > 0 && chosen.id !== "manual_pix" && (
            <div className="adm-alert" style={{ margin: 0 }}>
              <Icon name="shield" />
              <span><b>Chaves secretas ficam no servidor.</b> Coloque as credenciais no <code>backend/.env</code> (veja <code>.env.example</code>) e reinicie. Enquanto faltar, os pedidos vão para a equipe gerar o pagamento.</span>
            </div>
          )}

          {form.provider === "manual_pix" && (
            <div className="form-grid">
              <label className="field span-all"><span>Chave Pix da loja</span>
                <input className="input" value={form.pixKey} onChange={(e) => set("pixKey", e.target.value)} placeholder="CNPJ (só números), e-mail, +55 celular ou chave aleatória" />
                <small className="adm-muted">O sistema gera o Pix copia e cola com o valor exato de cada pedido.</small>
              </label>
              <label className="field span-2"><span>Nome do recebedor</span><input className="input" maxLength={25} value={form.merchantName} onChange={(e) => set("merchantName", e.target.value)} /></label>
              <label className="field"><span>Cidade</span><input className="input" maxLength={15} value={form.merchantCity} onChange={(e) => set("merchantCity", e.target.value)} /></label>
            </div>
          )}

          {(form.provider === "mercadopago" || form.provider === "asaas") && (
            <label className="pay-check">
              <input type="checkbox" checked={form.cardLink} onChange={(e) => set("cardLink", e.target.checked)} />
              <span>Enviar também um link para pagar com cartão{form.provider === "asaas" ? " ou boleto" : ""}</span>
            </label>
          )}

          <div className="form-grid">
            <label className="field"><span>Prazo para pagar (min)</span>
              <input className="input" inputMode="numeric" value={form.expiresMinutes} onChange={(e) => set("expiresMinutes", Number(e.target.value.replace(/\D/g, "")) || 0)} />
              <small className="adm-muted">Depois disso o pedido é cancelado e o estoque liberado.</small>
            </label>
            <label className="field"><span>Lembrete depois de (min)</span>
              <input className="input" inputMode="numeric" value={form.reminderMinutes} onChange={(e) => set("reminderMinutes", Number(e.target.value.replace(/\D/g, "")) || 0)} />
              <small className="adm-muted">Reenvia o Pix uma vez se ainda não pagou.</small>
            </label>
          </div>

          {(form.provider === "mercadopago" || form.provider === "asaas") && (
            <div className="adm-alert" style={{ margin: 0 }}>
              <Icon name="route" />
              {data.webhooks.publicUrl
                ? <span><b>Aviso de pagamento (webhook):</b> cadastre no painel do provedor <code>{form.provider === "mercadopago" ? data.webhooks.mercadopago : data.webhooks.asaas}</code>. Mesmo sem ele, o sistema consulta as cobranças a cada minuto.</span>
                : <span><b>Sem endereço público (PUBLIC_API_URL).</b> Tudo bem para testes: o sistema consulta as cobranças a cada minuto. Em produção, configure para a confirmação chegar na hora.</span>}
            </div>
          )}

          <div className="adm-form-actions">
            <button className="btn btn-outline btn-sm" onClick={onClose}>Cancelar</button>
            <button className="btn btn-primary btn-sm" onClick={save} disabled={saving}>{saving && <Icon name="loader" className="icon-sm spin" />}Salvar</button>
          </div>
        </div>
      )}
    </Dialog>
  );
}

type Payment = {
  id: number; provider: ProviderId; status: "pending" | "paid" | "expired" | "cancelled" | "failed"; amountCents: number;
  pixCode: string | null; paymentUrl: string | null; expiresAt: string; paidAt: string | null; remindedAt: string | null; createdAt: string; confirmedBy: string | null;
};

const PROVIDER_LABEL: Record<ProviderId, string> = { manual_pix: "Pix da loja", mercadopago: "Mercado Pago", asaas: "Asaas", efi: "Efí" };
const PAY_STATUS: Record<Payment["status"], string> = { pending: "Aguardando pagamento", paid: "Pago", expired: "Vencido", cancelled: "Substituído/cancelado", failed: "Falhou" };

// Bloco de pagamento dentro do pedido (Pedidos): situação, confirmar à mão e reenviar o Pix.
export function OrderPayment({ code, status, hasWhatsApp, onChanged }: { code: string; status: string; hasWhatsApp: boolean; onChanged: () => void }) {
  const { toast } = useStore();
  const { data, setData } = useApi<{ payments: Payment[] }>(`/admin/pagamentos/orders/${code}`);
  const [busy, setBusy] = useState<"confirm" | "resend" | null>(null);
  const [askDoc, setAskDoc] = useState(false);
  const [doc, setDoc] = useState("");
  const last = data?.payments[0];
  const awaiting = status === "pending";

  const run = async (kind: "confirm" | "resend") => {
    setBusy(kind);
    try {
      const body = kind === "resend" ? { document: doc.replace(/\D/g, "") || undefined } : {};
      setData(await api<{ payments: Payment[] }>(`/admin/pagamentos/orders/${code}/${kind}`, { body }));
      toast({ message: kind === "confirm" ? `${code}: pagamento confirmado. O cliente foi avisado.` : `${code}: Pix enviado ao cliente.` });
      setAskDoc(false);
      if (kind === "confirm") onChanged();
    } catch (e) {
      const msg = e instanceof ApiError ? e.message : "Não foi possível concluir";
      if (/CPF/i.test(msg)) setAskDoc(true);
      toast({ message: msg, kind: "error" });
    } finally { setBusy(null); }
  };

  return (
    <div className="pay-box">
      <h3>Pagamento</h3>
      {!data ? <div className="skeleton" style={{ height: 60 }} /> : last ? (
        <div className="pay-status" data-status={last.status}>
          <b>{PAY_STATUS[last.status]}</b>
          <small className="adm-muted">
            {PROVIDER_LABEL[last.provider]} · {brl(last.amountCents)}
            {last.status === "pending" && ` · vence ${dateTime(last.expiresAt)}`}
            {last.status === "paid" && last.paidAt && ` · ${dateTime(last.paidAt)}${last.confirmedBy ? ` por ${last.confirmedBy}` : ""}`}
            {last.remindedAt && last.status === "pending" && " · lembrete enviado"}
          </small>
          {last.status === "pending" && last.pixCode && (
            <button className="btn-link" onClick={() => navigator.clipboard?.writeText(last.pixCode!).then(() => toast({ message: "Pix copia e cola copiado." }))}>Copiar Pix copia e cola</button>
          )}
          {last.paymentUrl && last.status === "pending" && <a className="btn-link" href={last.paymentUrl} target="_blank" rel="noreferrer">Abrir link de pagamento</a>}
        </div>
      ) : <small className="adm-muted">{awaiting ? "Nenhuma cobrança gerada." : "Sem cobrança registrada neste pedido."}</small>}

      {awaiting && (
        <div className="pay-actions">
          <button className="btn btn-primary btn-sm" onClick={() => run("confirm")} disabled={!!busy}>
            <Icon name={busy === "confirm" ? "loader" : "checkCircle"} className={busy === "confirm" ? "icon-sm spin" : "icon-sm"} />Confirmar pagamento
          </button>
          {hasWhatsApp && (
            <button className="btn btn-outline btn-sm" onClick={() => run("resend")} disabled={!!busy}>
              <Icon name={busy === "resend" ? "loader" : "chat"} className={busy === "resend" ? "icon-sm spin" : "icon-sm"} />{last?.status === "pending" ? "Reenviar Pix" : "Gerar e enviar Pix"}
            </button>
          )}
        </div>
      )}
      {askDoc && (
        <label className="field" style={{ marginTop: 8 }}>
          <span>CPF/CNPJ do cliente (exigido pelo provedor)</span>
          <input className="input" inputMode="numeric" value={doc} onChange={(e) => setDoc(e.target.value)} placeholder="Só números" />
        </label>
      )}
    </div>
  );
}
