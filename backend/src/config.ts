import { z } from "zod";

const optionalSecret = z.string().optional().transform((v) => v?.trim() || undefined);

const schema = z.object({
  // Opcional para o servidor subir; rotas que usam banco respondem 503 até ser configurada.
  DATABASE_URL: z
    .string()
    .optional()
    .transform((v) => v?.trim() || undefined),
  JWT_SECRET: z.string().min(32, "JWT_SECRET precisa de pelo menos 32 caracteres"),
  PORT: z.coerce.number().int().default(3333),
  CORS_ORIGINS: z.string().default("http://localhost:5173,http://localhost:3000"),
  UPLOAD_DIR: z.string().default("./uploads"),
  // Supabase Storage para as fotos dos produtos. A URL sai do DATABASE_URL se não for informada.
  SUPABASE_URL: z.url().optional(),
  SUPABASE_SECRET_KEY: z.string().optional().transform((v) => v?.trim() || undefined),
  STORAGE_BUCKET: z.string().default("produtos"),
  // Em produção, pasta do site compilado (frontend/dist). A API passa a entregar o site também.
  STATIC_DIR: z.string().optional(),
  TZ_BUSINESS: z.string().default("America/Sao_Paulo"),
  // Painel admin sem login (temporário, só para desenvolvimento). Use "false" para exigir conta admin.
  ADMIN_AUTH_DISABLED: z.enum(["true", "false"]).default("false").transform((v) => v === "true"),
  // Robô vendedor com IA (Claude). Sem chave, o WhatsApp segue com o robô de regras (menus numerados).
  ANTHROPIC_API_KEY: z.string().optional().transform((v) => v?.trim() || undefined),
  AI_MODEL: z.string().default("claude-opus-5-5"),
  AI_EFFORT: z.enum(["low", "medium", "high"]).default("medium"),
  AI_ENABLED: z.enum(["true", "false"]).default("true").transform((v) => v === "true"),
  // Pagamentos. O provedor ativo é escolhido no painel; aqui ficam só as credenciais.
  // Endereço público da API (https://…/api), para os provedores avisarem pagamentos (webhooks).
  PUBLIC_API_URL: z.string().optional().transform((v) => v?.trim().replace(/\/+$/, "") || undefined),
  MP_ACCESS_TOKEN: optionalSecret,
  ASAAS_API_KEY: optionalSecret,
  ASAAS_SANDBOX: z.enum(["true", "false"]).default("true").transform((v) => v === "true"),
  ASAAS_WEBHOOK_TOKEN: optionalSecret,
  EFI_CLIENT_ID: optionalSecret,
  EFI_CLIENT_SECRET: optionalSecret,
  EFI_CERT_PATH: optionalSecret, // certificado .pem (pode conter também a chave)
  EFI_KEY_PATH: optionalSecret,  // chave .pem, se estiver em arquivo separado
  EFI_PIX_KEY: optionalSecret,
  EFI_SANDBOX: z.enum(["true", "false"]).default("true").transform((v) => v === "true"),
});

export type Config = z.infer<typeof schema>;

let cached: Config | undefined;

export function config(): Config {
  if (!cached) {
    const parsed = schema.safeParse(process.env);
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`).join("\n");
      throw new Error(`Configuração inválida:\n${issues}`);
    }
    cached = parsed.data;
  }
  return cached;
}
