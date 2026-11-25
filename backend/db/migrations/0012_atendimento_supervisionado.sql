-- Atendimento interativo: modo supervisionado (a equipe aprova as respostas do robô antes de enviar),
-- "por que o robô respondeu isso", avaliação de cada resposta e validação da conversa.

alter table conversation_messages
  -- sent = entregue ao cliente; pending = rascunho do robô esperando aprovação; discarded = não enviado
  add column status text not null default 'sent' check (status in ('sent', 'pending', 'discarded')),
  add column meta jsonb,                                   -- motor (ia/regras), o que consultou, etapa
  add column approval text check (approval in ('approved', 'edited', 'discarded')),
  add column approved_by integer references users(id) on delete set null,
  add column rating text check (rating in ('good', 'bad')),
  add column rating_note text,
  add column rated_by integer references users(id) on delete set null;
create index conversation_messages_pending_idx on conversation_messages (conversation_id) where status = 'pending';

alter table conversations
  add column review text check (review in ('ok', 'corrigida', 'problema')),
  add column review_note text,
  add column reviewed_by integer references users(id) on delete set null,
  add column reviewed_at timestamptz;

insert into site_settings (key, value) values ('attendance', '{"supervised": false}'::jsonb)
on conflict (key) do nothing;
