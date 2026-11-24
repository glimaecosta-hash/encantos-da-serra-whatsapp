# Encantos da Serra

Marketplace de laticínios artesanais da serra. **A venda acontece pelo WhatsApp**: o site é a vitrine e um
chatbot conduz a compra, com os responsáveis entrando na conversa quando precisa (veja “Atendimento pelo WhatsApp”).

Jornadas do site:

- **Quero comprar**: varejo para consumidor final (peças avulsas, carrinho, entrega refrigerada).
- **Atacado / B2B**: pedido rápido por caixa com preço por faixa de volume, cotação para grandes volumes.
- **Seja um produtor**: proposta de fornecimento em 3 etapas, com anexos e protocolo.

Projeto de estudos. Protótipo de referência no Figma.

## Estrutura

```
backend/    API (Bun + Hono + Postgres no Supabase)
frontend/   Site (React 19 servido pelo Bun, telas do Figma)
```

## Rodando tudo

Em dois terminais:

```bash
cd backend && bun run dev     # API em http://localhost:3333
cd frontend && bun run dev    # Site em http://localhost:5173
```

O site repassa `/api/*` para a API, então não precisa configurar CORS em dev.
Detalhes em [backend/README.md](backend/README.md) e [frontend/README.md](frontend/README.md).

## Publicação (Render)

O `render.yaml` cria um Web Service gratuito que compila o site e sobe a API, que passa a
entregar o site também (`STATIC_DIR`). O banco continua no Supabase.

1. No Render: **New → Blueprint** e escolha este repositório.
2. Preencha `DATABASE_URL` com a string do Supabase (Connect → Session pooler, porta 5432).
   O `JWT_SECRET` é gerado automaticamente.
3. Cada push na `main` publica de novo.

No plano gratuito o serviço dorme após 15 min sem visitas (a primeira visita leva cerca de
1 min) e o disco é apagado a cada reinício, então anexos de proposta não ficam salvos.
A documentação da API fica em `/docs`.


## Atendimento pelo WhatsApp

O site virou vitrine: cada “Pedir pelo WhatsApp” abre a conversa já com o produto (e a quantidade). O chatbot:

- mostra linhas, produtos, preços e só oferece o que tem em estoque;
- monta o carrinho, calcula o frete pelo CEP e informa a próxima rota;
- coleta o endereço e cria o pedido (reserva estoque como o checkout do site);
- informa a situação dos pedidos do cliente e avisa a cada mudança de status;
- transfere para uma pessoa quando o cliente pede, em atacado, reclamação, depois de criar um pedido
  (para combinar o pagamento) ou quando não entende o cliente 3 vezes.

No painel:

| Aba | Para quê |
| --- | --- |
| **Atendimento** | Fila das conversas por etapa (Com o chatbot → Aguardando atendente → Em atendimento → Aguardando cliente → Fechada). Assumir, responder, nota interna, respostas prontas, ficha do cliente, **Fechar pedido** com desconto negociado e venda por caixa, encerrar sem pedido com motivo. |
| **Simulador** | Testar o bot como se fosse o cliente. Tudo o que acontece ali cai em Atendimento, Pedidos e Estoque. |
| **Solicitações** | Cotações de atacado, propostas de produtores e mensagens do site (antes só existiam na API). |
| **Dashboard** | Novo bloco do WhatsApp: fila agora, conversas, % que vira pedido, pedidos só com o bot, tempo da 1ª resposta humana, assuntos e motivos de perda; vendas por origem (site × WhatsApp). |

Arquivos principais:

```
backend/db/migrations/0009_atendimento_whatsapp.sql  contatos, conversas, mensagens, orders.source
backend/src/lib/bot.ts                               chatbot (máquina de estados pura, testada em tests/bot.test.ts)
backend/src/lib/whatsapp.ts                          transporte das mensagens (hoje: simulador)
backend/src/repos/conversations.ts                   entrada de mensagens, fila, pedido pela conversa, avisos de status
backend/src/routes/attendance.ts                     /api/admin/atendimento/* e /api/whatsapp/info
frontend/src/admin/AttendancePage.tsx                tela de Atendimento
frontend/src/admin/SimulatorPage.tsx                 simulador
frontend/src/admin/RequestsPage.tsx                  Solicitações
frontend/src/whatsapp.tsx                            botões, botão flutuante e “Como comprar” do site
```

Configuração: **Painel → Atendimento → Configurações** (número, como aparece no site, horário humano).
Para voltar ao carrinho do site: `update site_settings set value = '"cart"' where key = 'shop_mode';`

### Ligar o WhatsApp de verdade (próximo passo)

Hoje roda em **modo simulador** (nenhuma mensagem sai para a internet). Para produção, use a
WhatsApp Cloud API (oficial da Meta): número dedicado + app aprovado. Depois é só:

1. trocar o transporte em `backend/src/lib/whatsapp.ts` por uma chamada a `POST /{PHONE_NUMBER_ID}/messages`;
2. criar a rota de webhook que recebe as mensagens e chama `handleInbound()`.

O bot, a fila, o painel e os pedidos não mudam.
