-- Pagamentos dos pedidos (Pix e link de cartão), por provedor: Pix copia e cola gerado pela loja,
-- Mercado Pago, Asaas ou Efí. Um pedido pode ter várias cobranças (ex.: Pix vencido e gerado de novo);
-- só uma fica "pending" por vez.

create table payments (
  id serial primary key,
  order_id integer not null references orders(id) on delete cascade,
  reference text not null unique,             -- nosso identificador (txid do Pix / external_reference)
  provider text not null check (provider in ('manual_pix', 'mercadopago', 'asaas', 'efi')),
  status text not null default 'pending' check (status in ('pending', 'paid', 'expired', 'cancelled', 'failed')),
  amount_cents integer not null check (amount_cents > 0),
  external_id text,                            -- id da cobrança no provedor
  pix_code text,                               -- Pix copia e cola
  payment_url text,                            -- link de pagamento (cartão / fatura)
  expires_at timestamptz not null,
  reminded_at timestamptz,
  paid_at timestamptz,
  confirmed_by integer references users(id) on delete set null,  -- confirmação manual no painel
  last_checked_at timestamptz,
  error text,
  created_at timestamptz not null default now()
);
create index payments_order_idx on payments (order_id, created_at desc);
create index payments_pending_idx on payments (expires_at) where status = 'pending';
create unique index payments_one_pending_idx on payments (order_id) where status = 'pending';
alter table payments enable row level security;

-- Configuração escolhida no painel. As chaves secretas dos provedores ficam no .env, nunca aqui.
insert into site_settings (key, value) values
  ('payments', '{"provider": "manual_pix", "cardLink": true, "pixKey": "", "merchantName": "Encantos da Serra", "merchantCity": "Belo Horizonte", "expiresMinutes": 120, "reminderMinutes": 30}'::jsonb)
on conflict (key) do nothing;
