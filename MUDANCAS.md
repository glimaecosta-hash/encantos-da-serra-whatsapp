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
