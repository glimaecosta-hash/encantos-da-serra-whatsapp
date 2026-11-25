-- Central do Robô: perguntas que o robô não soube responder. Os donos respondem no painel e a resposta
-- vira uma pergunta frequente no rascunho do robô (publicada quando eles quiserem).
-- A configuração do robô (rascunho, publicada e histórico) fica em site_settings, chave 'bot_config'.

create table bot_questions (
  id serial primary key,
  question text not null,
  normalized text not null,                  -- para juntar perguntas repetidas
  conversation_id integer references conversations(id) on delete set null,
  source text not null default 'robo' check (source in ('robo', 'ia')),
  status text not null default 'open' check (status in ('open', 'answered', 'ignored')),
  times integer not null default 1,          -- quantas vezes apareceu
  answer text,
  answered_by integer references users(id) on delete set null,
  last_asked_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);
create index bot_questions_status_idx on bot_questions (status, last_asked_at desc);
create unique index bot_questions_open_unique on bot_questions (normalized) where status = 'open';
alter table bot_questions enable row level security;
