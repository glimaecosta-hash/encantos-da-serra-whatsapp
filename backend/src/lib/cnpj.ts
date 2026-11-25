import { onlyDigits } from "./text";

// Valida os dígitos verificadores do CNPJ (formato numérico de 14 dígitos).
export function isValidCnpj(input: string): boolean {
  const cnpj = onlyDigits(input);
  if (cnpj.length !== 14 || /^(\d)\1+$/.test(cnpj)) return false;
  const digit = (base: string) => {
    const weights = base.length === 12 ? [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2] : [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
    const sum = [...base].reduce((acc, ch, i) => acc + Number(ch) * weights[i]!, 0);
    const rest = sum % 11;
    return rest < 2 ? 0 : 11 - rest;
  };
  const d1 = digit(cnpj.slice(0, 12));
  const d2 = digit(cnpj.slice(0, 12) + d1);
  return cnpj.endsWith(`${d1}${d2}`);
}

// Valida os dígitos verificadores do CPF (11 dígitos).
export function isValidCpf(input: string): boolean {
  const cpf = onlyDigits(input);
  if (cpf.length !== 11 || /^(\d)\1+$/.test(cpf)) return false;
  const digit = (base: string) => {
    const sum = [...base].reduce((acc, ch, i) => acc + Number(ch) * (base.length + 1 - i), 0);
    const rest = (sum * 10) % 11;
    return rest === 10 ? 0 : rest;
  };
  const d1 = digit(cpf.slice(0, 9));
  const d2 = digit(cpf.slice(0, 9) + d1);
  return cpf.endsWith(`${d1}${d2}`);
}

export function formatCnpj(input: string): string {
  const c = onlyDigits(input);
  return `${c.slice(0, 2)}.${c.slice(2, 5)}.${c.slice(5, 8)}/${c.slice(8, 12)}-${c.slice(12)}`;
}
