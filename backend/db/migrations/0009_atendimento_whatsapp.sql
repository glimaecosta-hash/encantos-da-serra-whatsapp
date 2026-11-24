-- Atendimento pelo WhatsApp: contatos, conversas (com etapa do funil), mensagens e origem dos pedidos.
-- O chatbot conduz a conversa (mode = 'bot') até o cliente pedir um atendente ou o caso precisar de negociação;
-- aí um responsável assume (mode = 'human'). A etapa (stage) organiza a fila do painel.

-- Contato do WhatsApp. Ganha um usuário "sombra" na primeira compra, para o pedido seguir o fluxo normal.
create table wa_contacts (
  id serial primary key,
  phone text not null unique,               -- só dígitos, com DDI: 5531999990000
  name text,
  user_id integer references users(id) on delete set null,
  business_name text,                        -- empório/restaurante, quando é cliente de atacado
  notes text,                                -- observações fixas sobre o cliente (preferências, combinados)
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table conversations (
  id serial primary key,
  contact_id integer not null references wa_contacts(id) on delete cascade,
  -- Etapas do funil de atendimento:
  --   bot          → chatbot atendendo sozinho
  --   waiting      → cliente pediu atendente / caso escalado (fila)
  --   negotiating  → responsável negociando (preço, volume, prazo)
  --   awaiting_customer → responsável respondeu, esperando o cliente
  --   won          → virou pedido
  --   lost         → encerrada sem pedido
  stage text not null default 'bot'
    check (stage in ('bot', 'waiting', 'negotiating', 'awaiting_customer', 'won', 'lost')),
  mode text not null default 'bot' check (mode in ('bot', 'human')),
  topic text not null default 'compra'
    check (topic in ('compra', 'atacado', 'pedido', 'duvida', 'reclamacao')),
  assigned_to integer references users(id) on delete set null,
  bot_state text not null default 'start',
  bot_data jsonb not null default '{}'::jsonb,  -- carrinho e dados coletados pelo bot
  order_id integer references orders(id) on delete set null,
  lost_reason text,
  unread_count integer not null default 0,
  last_message_at timestamptz not null default now(),
  last_customer_at timestamptz,
  waiting_since timestamptz,                    -- quando entrou na fila de atendente
  first_human_reply_at timestamptz,
  closed_at timestamptz,
  created_at timestamptz not null default now()
);
create index conversations_stage_idx on conversations (stage, last_message_at desc);
create index conversations_contact_idx on conversations (contact_id, created_at desc);
-- No máximo uma conversa aberta por contato.
create unique index conversations_one_open_idx on conversations (contact_id) where closed_at is null;

create table conversation_messages (
  id serial primary key,
  conversation_id integer not null references conversations(id) on delete cascade,
  -- customer = cliente; bot = chatbot; agent = responsável; note = nota interna (cliente não vê); system = evento
  author text not null check (author in ('customer', 'bot', 'agent', 'note', 'system')),
  agent_id integer references users(id) on delete set null,
  body text not null,
  options jsonb,                                -- opções numeradas que o bot ofereceu
  created_at timestamptz not null default now()
);
create index conversation_messages_conv_idx on conversation_messages (conversation_id, id);

-- Onde o pedido nasceu (o canal continua sendo varejo/atacado).
alter table orders add column source text not null default 'site' check (source in ('site', 'whatsapp', 'painel'));
alter table orders add column conversation_id integer references conversations(id) on delete set null;

-- Configurações do atendimento (número exibido no site, horário, modo de venda do site).
insert into site_settings (key, value) values
  ('whatsapp', '{"number": "5531999990000", "displayNumber": "(31) 99999-0000", "hours": "Seg a sex, 8h às 18h · Sáb, 8h às 12h"}'::jsonb),
  ('shop_mode', '"whatsapp"'::jsonb)
on conflict (key) do nothing;

alter table wa_contacts enable row level security;
alter table conversations enable row level security;
alter table conversation_messages enable row level security;
