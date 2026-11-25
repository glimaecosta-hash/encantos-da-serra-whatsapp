# O que mudou — estoque e painel para os donos (fase 7)

## Tela "Hoje" (nova página inicial do painel)
- Num lugar só, cada bloco com o botão que leva até onde a coisa se resolve:
  - clientes esperando (incluindo respostas do robô para aprovar);
  - pedidos para separar;
  - entregas do dia;
  - Pix em aberto;
  - estoque pedindo atenção;
  - perguntas que o robô não soube responder.
- O topo mostra os pedidos e as vendas do dia. A tela se atualiza sozinha a cada minuto.

## Menu agrupado
- **Hoje · Vender** (Atendimento, Pedidos) **· Operação** (Estoque, Rotas) **· Catálogo** (Produtos, Robô) **· Gestão** (Dashboard, Solicitações, Simulador).
- Pedidos agora fica em `/admin/pedidos`. Links antigos (`/admin?q=PED-…`) continuam funcionando.

## Estoque
- **Entrada de coleta:** escolha o produtor e digite o que chegou de cada produto, em caixas ou unidades. Cada entrada vira um lote com validade.
- **Contagem em lote:** todos os produtos numa tela. Só os preenchidos são registrados, e a diferença vira ajuste. Tudo ou nada: se um item der erro, nada é gravado.
- **Folha de contagem** para imprimir e levar à câmara fria. Ela não mostra o saldo, para a contagem ser às cegas.
- **Exportar planilha** (CSV para Excel, com acentos).
- **Pausar / Ativar no site** direto na lista: o produto sai da loja e do robô, mas continua no estoque.
- **Filtros** por produtor e categoria. A lista continua do mais urgente para o menos urgente.
- **No celular**, cada produto vira um cartão, para usar dentro da câmara fria.

## Pedidos
- **Seleção em massa:** marque vários pedidos e avance todos juntos (Separar, Expedir, Marcar entregue).
  - Cada cliente recebe o aviso no WhatsApp.
  - Só aparecem as ações que valem para todos os selecionados.
  - Um pedido com erro (ex.: sem estoque para expedir) não trava os outros, e o aviso diz qual ficou de fora.
- **Lista de separação por rota**, pronta para imprimir:
  - agrupada por dia e região;
  - com o total de cada produto a separar e o que vai em cada pedido;
  - com caixinhas para marcar;
  - usa os pedidos selecionados ou, sem seleção, todos os pagos e em separação.

## Técnico
- Novas rotas:
  - `GET /api/admin/today`;
  - `POST /api/admin/inventory/batch` (contagem/entrada, numa transação);
  - `POST /api/admin/orders/bulk-events`.
- `GET /api/admin/inventory` passou a trazer produtor e categoria.
- Sem migração de banco. `bun test`: 84 testes.
- Testado com o banco real: a entrada de 1 un seguida da contagem voltou o saldo ao original; as ações em massa com códigos inexistentes devolveram o erro de cada um.

---

# O que mudou — vitrine no padrão de marketing (fase 6)

Regra seguida em todas as telas: **um próximo passo principal por bloco**, sempre no mesmo estilo de botão. As dúvidas que seguram a compra são respondidas perto do botão.

## Home (nova ordem)
1. **Promessa:** banner com um botão por destaque e os atalhos de entrega e atacado.
2. **Confiança:** faixa com os números reais da loja (48h da serra ao destino, +120 produtores, avaliação 4,9/5, cadeia refrigerada 100% monitorada).
3. **Categorias:** atalhos por linha.
4. **Mais vendidos.**
5. **Como comprar:** carrinho → WhatsApp.
6. **Queijos da serra.**
7. **Quem faz:** foto e texto sobre as famílias produtoras, com o lote da semana. Leva para "Nossa história".
8. **Doce de leite e manteiga.**
9. **Entregamos na sua região?:** consulta de frete pelo CEP.
10. **Chamada final:** "Monte sua tábua da serra", com "Ver todos os produtos" e "Pedir ajuda" no WhatsApp.

## Página do produto
- **Selos** logo abaixo do botão de compra: entrega refrigerada 2 a 8 °C, origem conhecida (produtor e cidade) e pagamento seguro.
- **Como é feito**, **Combina com** e **Como guardar** aparecem quando os donos preenchem a ficha do produto na Central do Robô e publicam. A mesma ficha ensina o robô e informa o site. As "observações de venda" continuam internas.
- **Leve junto:** mais vendidos de outras linhas, com estoque (ex.: doce de leite e manteiga para quem olha um queijo maturado).
- **Da mesma linha:** os produtos parecidos, com link para a categoria.

## Carrinho
- **Leve junto** no carrinho (4 sugestões) e no carrinho lateral ("Combina com o seu pedido", 2 sugestões), com botão de adicionar em um toque. As sugestões dão preferência a linhas que ainda não estão no carrinho.
- A barra de frete grátis da fase 1 continua.

## Cabeçalho
- Novo link **Como comprar** (modo WhatsApp). No menu do celular entraram "Como comprar" e "Carrinho".

## Técnico
- `GET /api/products/:slug` agora devolve `knowledge` (ficha publicada, sem as observações internas) e `pairsWith` ("Leve junto"). Sem migração de banco.

---

# O que mudou — Atendimento interativo (fase 5)

## Modo supervisionado (Atendimento → chave "Modo supervisionado")
- Ligado, as respostas do robô **não vão para o cliente**: ficam como rascunho tracejado na conversa. Isso inclui o Pix depois de um pedido. Vale para o robô de regras e para a IA.
- Em cada rascunho: **Enviar**, **Editar** (envia a versão da equipe) ou **Descartar**.
- A barra "N respostas esperando aprovação" tem **Enviar todas** e **Descartar e assumir** (a conversa passa para a equipe).
- As conversas com rascunho entram em **Precisam de você** e no novo filtro **Aprovar respostas**. Elas aparecem primeiro na lista.
- Avisos automáticos (pagamento confirmado, lembrete, status do pedido) não passam pela aprovação.
- A IA só considera como histórico o que o cliente realmente recebeu.

## Em cada mensagem
- **Por quê?** nas respostas do robô: mostra se foi a IA ou o robô de regras, o que ele consultou (produto, carrinho, frete, pagamento…), a etapa da conversa e o motivo de ter chamado a equipe.
  - Isso substitui a nota "🤖 IA: …" da fase 2.
- **👍 / 👎** nas respostas do robô. O 👎 pede "o que deveria ter respondido" e oferece **Salvar e ensinar ao robô**.
- **Ensinar ao robô** nas mensagens da equipe: a pergunta do cliente e a resposta da equipe viram uma pergunta frequente no rascunho da Central do Robô. É preciso revisar e publicar.

## Validação da conversa (ficha do cliente)
- **✓ Correta**, **✎ Corrigida** ou **⚠ Problema**, com observação, quem validou e quando. Conversas com problema ganham uma etiqueta na lista.

## Qualidade (Central do Robô → Qualidade)
- Em 7, 30 ou 90 dias:
  - % de conversas resolvidas só pelo robô;
  - % que passaram para a equipe e o tempo mediano de espera;
  - pedidos fechados pelo robô e pela equipe;
  - % de respostas com 👍;
  - % aprovadas sem mudança (no modo supervisionado);
  - % de conversas validadas como corretas.
- Listas das respostas com 👎 (com o que deveria ter sido dito) e das conversas com problema, com link para a conversa.

## Técnico
- Migração `0012_atendimento_supervisionado.sql`: colunas de situação, "porquê", aprovação e avaliação em `conversation_messages`; validação em `conversations`; configuração `attendance`. Rode `bun run db:migrate`.
- `bun test`: 84 testes. O fluxo supervisionado foi testado de ponta a ponta com o banco real.

---

# O que mudou — Central do Robô (fase 4)

Nova aba **Robô** no painel. Os donos ensinam e ajustam o robô do WhatsApp sem programador.

## Como funciona
- Tudo é editado num **rascunho**. Os clientes continuam com a **versão publicada** até alguém clicar em **Publicar**.
- **Testar rascunho** abre o Simulador usando o rascunho. No Simulador, dá para alternar entre a versão "Publicada" e o "Rascunho".
- Cada publicação guarda a anterior em **Versões** (até 10). Dá para trazer uma versão antiga de volta para o rascunho.

## Abas
| Aba | O que os donos fazem |
|---|---|
| **Personalidade** | Nome da atendente virtual, jeito de falar (acolhedor, formal ou descontraído), boas-vindas com prévia e uso de emojis |
| **Conhecimento** | Texto sobre a loja e **perguntas frequentes** (pergunta, resposta e palavras-chave) |
| **Produtos** | Ficha de cada produto: como é feito, com o que combina, como guardar e observações de venda |
| **Regras de venda** | Desconto máximo da IA (0 = nenhum), pedido mínimo, oferecer complemento, avisar do frete grátis, palavras que chamam a equipe e orientações extras para a IA |
| **Perguntas sem resposta** | Perguntas que o robô não soube responder (repetidas são agrupadas, com link para a conversa). **Responder e ensinar** transforma a resposta em pergunta frequente no rascunho |
| **Versões** | Histórico das publicações |

## O que já vale sem a IA (robô de regras)
- Boas-vindas personalizadas, emojis ligados ou desligados e pedido mínimo.
- Respostas das perguntas frequentes pela palavra-chave, no começo da conversa e no menu.
- Palavras que chamam a equipe.
- Frases que o robô não entendeu (com cara de pergunta) vão para "Perguntas sem resposta".

## Com a IA ligada
- Tudo acima, mais: o tom, o nome, as fichas dos produtos e as orientações dos donos entram nas instruções da IA.
- **Desconto:** a IA só pode dar desconto até o limite definido. Ele aparece no resumo e vai para o pedido. A ferramenta de desconto nem existe para a IA quando o limite é 0.
- A IA registra sozinha as perguntas que não sabe responder.
- Preço, estoque, pagamento e segurança continuam garantidos pelo sistema: as orientações dos donos não mudam essas regras.

## Técnico
- Migração `0011_central_do_robo.sql` (tabela `bot_questions`). A configuração fica em `site_settings`, chave `bot_config`, com rascunho, versão publicada e histórico. Rode `bun run db:migrate`.
- `bun test`: 84 testes (12 novos para a Central: saudação, perguntas frequentes, palavras da equipe, emojis, pedido mínimo, perguntas sem resposta, instruções da IA e limite de desconto).

---

# O que mudou — pagamento completo (fase 3)

## Para o cliente (WhatsApp)
- Assim que o pedido é fechado (pelo robô, pela IA ou pela equipe), chegam os dados de pagamento:
  - uma mensagem com o total, o prazo e como pagar;
  - o **Pix copia e cola sozinho** na mensagem seguinte, para copiar com um toque;
  - um **link para cartão** (Mercado Pago, ou cartão e boleto no Asaas), quando ligado.
- **Lembrete** automático se o Pix não for pago (padrão: depois de 30 min).
- No **fim do prazo** (padrão: 2 h) o pedido é cancelado e a reserva de estoque é liberada. O cliente recebe o aviso.
- Pagamento confirmado: o pedido passa para "Pagamento confirmado" e o cliente é avisado.
- "Já paguei" ou "comprovante":
  - com confirmação automática, o robô explica que ela chega sozinha e reenvia o código;
  - com o Pix da loja, a conversa vai para a equipe conferir.
- Com o Asaas, o robô pede o **CPF** antes do resumo e confere se é válido.

## Formas de pagamento (escolhidas em Pedidos → Pagamentos)
| Opção | Confirmação | Precisa de |
|---|---|---|
| **Pix copia e cola da loja** | Equipe confirma em Pedidos | Só a chave Pix, cadastrada no painel |
| **Mercado Pago** | Automática | `MP_ACCESS_TOKEN` |
| **Asaas** | Automática | `ASAAS_API_KEY` (e o CPF do cliente) |
| **Efí** | Automática | Client ID/Secret, certificado `.pem` e chave Pix |
- O Pix da loja é gerado pelo próprio sistema no padrão do Banco Central. O teste confere o exemplo oficial do manual.
- As chaves secretas ficam só no `backend/.env`, nunca no banco.
- A confirmação nunca confia só no aviso recebido: o sistema sempre consulta a cobrança no provedor.

## Para os responsáveis (painel)
- **Pedidos → Pagamentos:** escolher o provedor, cadastrar a chave Pix, ligar o link de cartão e definir prazo e lembrete. A tela mostra o que falta configurar em cada provedor.
- Em cada pedido, o bloco **Pagamento** mostra a situação, o valor, o prazo e quem confirmou, com os botões:
  - **Confirmar pagamento**;
  - **Reenviar Pix** ou **Gerar e enviar Pix**, que pede o CPF quando o provedor exige;
  - **Copiar Pix copia e cola**.
- Se o provedor falhar, o cliente é avisado de que a equipe vai mandar o pagamento, e a conversa entra em "Precisam de você" com o motivo.

## Técnico
- Migração `0010_pagamentos.sql` (tabela `payments` e configuração `payments`). Rode `bun run db:migrate`.
- Rotina a cada minuto (`index.ts`): consulta as cobranças automáticas, envia lembretes e encerra as vencidas.
- Avisos dos provedores (webhooks):
  - Mercado Pago: `POST /api/payments/webhooks/mercadopago`;
  - Asaas: `POST /api/payments/webhooks/asaas`, com o token `ASAAS_WEBHOOK_TOKEN`;
  - Efí: só a consulta a cada minuto (o aviso dela exige certificado também no nosso servidor).
- `bun test`: 72 testes. Os 16 novos cobrem o Pix, o CPF, os três provedores com respostas simuladas e os fluxos de CPF e "já paguei" nos dois robôs.

## Ainda não testado com os provedores reais
- Mercado Pago, Asaas e Efí foram montados pela documentação oficial atual e testados com respostas simuladas. Falta rodar no **sandbox** de cada um, com as credenciais de teste.
- Mercado Pago: os clientes do WhatsApp usam um e-mail interno (`whatsapp+...@clientes.encantos`) como pagador. Conferir no sandbox se é aceito.
- Mercado Pago: o pagamento com cartão pelo link só é confirmado pelo aviso (webhook), que exige `PUBLIC_API_URL`.

---

# O que mudou — robô vendedor com IA (fase 2)

## Para o cliente (WhatsApp)
- Com a IA ligada, o robô entende frases livres ("tem queijo de cabra?", "quero algo para presente que combine com vinho"). Ele pergunta a ocasião e as preferências, recomenda produtos explicando cura, leite, origem e produtor, e oferece um complemento.
- A IA conduz a compra inteira na conversa: carrinho, CEP e frete, endereço, resumo e fechamento.
- Ela chama uma pessoa da equipe em reclamações, atacado, pedidos de desconto, dúvidas que não sabe responder ou quando o cliente pede.

## Travas de segurança (feitas no sistema, não na IA)
- Preço, estoque, frete e total vêm sempre do sistema. A IA não consegue colocar no carrinho um produto esgotado ou acima do estoque.
- O pedido só é fechado depois que o cliente **viu o resumo oficial e respondeu** numa nova mensagem. Se o carrinho ou o endereço mudar depois do resumo, ele precisa ser gerado de novo.
- A IA não dá desconto e não pede dados de cartão.
- O carrinho vindo do site continua com o robô de regras, que é exato e não custa nada. A IA segue a partir dali.
- Se a IA falhar numa mensagem (erro, instabilidade, limite de etapas), o **robô de regras responde** e o motivo fica no log do servidor.

## Para os responsáveis (painel)
- Selo **Robô com IA** ou **Robô de regras** no Atendimento, com explicação em Configurações.
- Cada resposta da IA deixa uma **nota interna** na conversa com o que ela consultou ou fez: "🤖 IA: consultou produto (CAN-MC600) · alterou o carrinho · calculou o frete…". A nota não vai para o cliente.

## Como ligar
1. Crie uma chave em console.anthropic.com → API Keys.
2. Coloque `ANTHROPIC_API_KEY=...` no `backend/.env` e reinicie o backend.
3. Teste em **Painel → Simulador**. Opcionais: `AI_MODEL` (padrão `claude-opus-5-5`), `AI_EFFORT` (`low`, `medium` ou `high`) e `AI_ENABLED=false` para desligar.
- Sem a chave, tudo continua como antes (robô de regras).

## Técnico
- `backend/src/lib/agent.ts`: loop de ferramentas na API de Mensagens, com cache do bloco fixo (regras, informações da loja e catálogo) e reexecução automática em outro modelo quando a resposta é recusada.
- Nova dependência: `@anthropic-ai/sdk`. Sem migração de banco.
- `bun test`: 56 testes. Os 8 novos usam uma IA roteirizada (sem rede e sem custo) e provam as travas: estoque, confirmação antes de fechar, resumo refeito após mudança, transferência, recusa e limite de etapas.

---

# O que mudou — carrinho que finaliza pelo WhatsApp (fase 1)

## Para o cliente (site)
- O carrinho voltou, mesmo com a venda pelo WhatsApp: **Adicionar ao carrinho** é o botão principal em cada produto. Ao adicionar, abre o **carrinho lateral** (itens, quantidade, subtotal).
- No carrinho, **Finalizar pelo WhatsApp** abre a conversa com todos os itens e códigos. Se o cliente informou o CEP, ele vai junto e o frete já aparece na tela, com a barra **"faltam R$ X para frete grátis"**.
- Quem quer um item só continua com o atalho **Pedir só este pelo WhatsApp** no card e na página do produto.
- No celular, uma **barra fixa** mostra itens e subtotal enquanto o cliente navega.
- O cabeçalho mostra sempre o carrinho, com contador, e o WhatsApp.

## Chatbot
- Lê a mensagem do carrinho do site com **vários produtos de uma vez**, em qualquer etapa da conversa. Preço e estoque vêm do sistema, nunca da mensagem.
- Item esgotado sai do carrinho com aviso. Quantidade acima do estoque é ajustada. Com CEP na mensagem, o robô pula direto para o endereço.
- Carrinho com caixas (conta de empresa) ou mais de 50 unidades de um item vai para o comercial (atacado).
- O formato da mensagem está em `cartMessage()` (`frontend/src/whatsapp.tsx`) e `siteCartFromMessage()` (`backend/src/lib/bot.ts`). Mude os dois juntos.

## Técnico
- Sem migração de banco. `bun test`: 48 testes (7 novos do carrinho do site).

---

# O que mudou — venda pelo WhatsApp

## Para o cliente (site)
- Botões “Adicionar ao carrinho” viraram **Pedir pelo WhatsApp** (produto, página do produto) e **Negociar pelo WhatsApp** (atacado). A mensagem já vai com o código do produto e a quantidade, e o chatbot continua de onde o cliente parou.
- Seção **Como comprar** (3 passos) na home e em `/carrinho`, e botão flutuante do WhatsApp em todas as páginas.
- O estoque mostrado no site continua o mesmo; o pedido feito no WhatsApp reserva estoque igual ao site.

## Para os responsáveis (painel)
- **Atendimento**: fila por etapa, contador “Precisam de você” no menu, assumir/devolver ao chatbot, respostas prontas, nota interna, ficha do cliente (empresa, observações, pedidos, conversas anteriores), **Fechar pedido** com desconto e caixas, encerrar com motivo.
- **Simulador**: testar e demonstrar o chatbot sem número oficial.
- **Solicitações**: cotações, propostas de produtores e mensagens do site com ações (responder, aprovar, marcar como respondida).
- **Pedidos**: selo “WhatsApp” com link para a conversa, telefone do cliente e desconto. Cada mudança de status avisa o cliente no WhatsApp.
- **Dashboard**: bloco de atendimento e vendas por origem.

## Técnico
- Migração `0009` (não altera dados existentes). Rode `bun run db:migrate` no backend antes de publicar.
- `bun test`: 41 testes (15 novos do chatbot). `typecheck` limpo no backend e no frontend.
- `bun run db:seed --reset` recria a demonstração, com 5 conversas geradas pelo próprio chatbot.
