import { onlyDigits } from "./text";

// Pix copia e cola (BR Code) no padrão EMV do Banco Central, gerado pela própria loja a partir da chave Pix.
// Não depende de banco ou provedor: o cliente paga e a equipe confirma o recebimento no painel.

const field = (id: string, value: string) => `${id}${String(value.length).padStart(2, "0")}${value}`;

// CRC16-CCITT (polinômio 0x1021, valor inicial 0xFFFF), exigido no campo 63 do BR Code.
export function crc16(payload: string): string {
  let crc = 0xffff;
  for (const byte of new TextEncoder().encode(payload)) {
    crc ^= byte << 8;
    for (let i = 0; i < 8; i++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc.toString(16).toUpperCase().padStart(4, "0");
}

// Nome e cidade do recebedor: sem acentos, só caracteres simples (alguns apps de banco recusam o resto).
const plain = (s: string, max: number) =>
  s.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^A-Za-z0-9 .\-]/g, "").trim().slice(0, max);

export type PixInput = {
  key: string;          // chave Pix (CPF/CNPJ, e-mail, telefone +55… ou aleatória)
  name: string;         // nome do recebedor (até 25)
  city: string;         // cidade do recebedor (até 15)
  amountCents?: number; // valor; sem valor, o pagador digita
  txid?: string;        // identificador da cobrança (até 25, letras e números)
  description?: string; // mensagem para o pagador
};

export function pixCopyPaste(p: PixInput): string {
  const txid = (p.txid ?? "").replace(/[^A-Za-z0-9]/g, "").slice(0, 25) || "***";
  const desc = p.description ? plain(p.description, 40) : "";
  const account = field("00", "br.gov.bcb.pix") + field("01", p.key.trim()) + (desc ? field("02", desc) : "");
  const payload =
    field("00", "01") +
    field("26", account) +
    field("52", "0000") +
    field("53", "986") +
    (p.amountCents ? field("54", (p.amountCents / 100).toFixed(2)) : "") +
    field("58", "BR") +
    field("59", plain(p.name, 25) || "Recebedor") +
    field("60", plain(p.city, 15) || "Brasil") +
    field("62", field("05", txid)) +
    "6304";
  return payload + crc16(payload);
}

// Chave Pix válida? (CPF, CNPJ, e-mail, celular com +55 ou chave aleatória)
export function isValidPixKey(key: string): boolean {
  const k = key.trim();
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(k)) return true;
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(k)) return k.length <= 77;
  if (/^\+55\d{10,11}$/.test(k)) return true;
  return /^\d{11}$|^\d{14}$/.test(k) && onlyDigits(k) === k;
}
