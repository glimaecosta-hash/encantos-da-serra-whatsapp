import type { BotMessage } from "./bot";

// Transporte das mensagens para o WhatsApp do cliente.
//
// Hoje o atendimento roda no modo SIMULADOR: as mensagens ficam gravadas na conversa e o simulador do painel
// (Painel → Simulador) mostra o que o cliente veria. Nada sai para a internet.
//
// Para ligar o WhatsApp de verdade (WhatsApp Cloud API da Meta), troque a implementação abaixo por uma chamada a
//   POST https://graph.facebook.com/v21.0/{PHONE_NUMBER_ID}/messages
// com { messaging_product: "whatsapp", to: phone, type: "text", text: { body: msg.body } }
// e crie a rota de webhook que recebe as mensagens e chama handleInbound() (repos/conversations.ts).
// O restante (bot, fila, painel, pedidos) já funciona igual.

export type Transport = { name: string; send(phone: string, msg: BotMessage): Promise<void> };

const simulator: Transport = {
  name: "simulador",
  async send() {
    // As mensagens já estão gravadas em conversation_messages; o simulador lê de lá.
  },
};

let transport: Transport = simulator;

export const sendWhatsApp = (phone: string, msg: BotMessage) => transport.send(phone, msg);
export const transportName = () => transport.name;
// Usado nos testes e, no futuro, para registrar o transporte da API oficial.
export function setTransport(t: Transport) {
  transport = t;
}
