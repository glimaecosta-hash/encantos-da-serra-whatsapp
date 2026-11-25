import { Hono } from "hono";
import { z } from "zod";
import { db } from "../db";
import { adminAccess, currentUser } from "../lib/auth";
import { addressSchema, cepSchema } from "../lib/schemas";
import type { AppEnv } from "../lib/types";
import { validate } from "../lib/validate";
import { transportName } from "../lib/whatsapp";
import {
  addNote, agentReply, approvePending, assume, attendanceSettings, botMode, discardPending, getConversation, rateMessage, reviewConversation, setSupervised, handleInbound, listConversations, markRead, orderFromConversation,
  releaseToBot, setStage, simulatorContacts, simulatorThread, STAGES, updateContact, whatsappSettings,
} from "../repos/conversations";

const idParam = (v: string) => {
  const id = Number(v);
  return Number.isInteger(id) && id > 0 ? id : 0;
};

const settingsSchema = z.object({
  number: z.string().transform((v) => v.replace(/\D/g, "")).refine((v) => v.length >= 12 && v.length <= 13, "Use DDI + DDD + número, ex.: 5531999990000"),
  displayNumber: z.string().trim().min(8).max(30),
  hours: z.string().trim().min(3).max(120),
});

// Público: o site precisa do número para montar os links "Pedir pelo WhatsApp".
export const whatsappPublicRoutes = new Hono<AppEnv>().get("/info", async (c) => {
  const s = await whatsappSettings();
  const [mode] = await db()`select value from site_settings where key = 'shop_mode'`;
  // jsonb com string simples volta já como texto; se vier serializado, desembrulha.
  const raw = mode?.value;
  const shopMode = typeof raw === "string" && raw.startsWith('"') ? JSON.parse(raw) : (raw ?? "whatsapp");
  return c.json({ number: s.number, displayNumber: s.displayNumber, hours: s.hours, shopMode });
});

// Painel → Atendimento (fila de conversas do WhatsApp) e Simulador.
export const attendanceRoutes = new Hono<AppEnv>()
  .use(adminAccess)

  .get("/", validate("query", z.object({ view: z.string().default("open"), q: z.string().optional() })), async (c) => {
    const { view, q } = c.req.valid("query");
    return c.json({ ...(await listConversations({ view, q, userId: currentUser(c).id })), transport: transportName(), bot: botMode(), ...(await attendanceSettings()) });
  })

  .get("/settings", async (c) => c.json({ settings: await whatsappSettings(), transport: transportName(), bot: botMode(), ...(await attendanceSettings()) }))

  // Modo supervisionado: respostas do robô esperam aprovação da equipe.
  .put("/supervision", validate("json", z.object({ supervised: z.boolean() })), async (c) =>
    c.json(await setSupervised(c.req.valid("json").supervised)))

  .put("/settings", validate("json", settingsSchema), async (c) => {
    const value = JSON.stringify(c.req.valid("json"));
    await db()`
      insert into site_settings (key, value) values ('whatsapp', ${value}::text::jsonb)
      on conflict (key) do update set value = excluded.value`;
    return c.json({ settings: await whatsappSettings() });
  })

  // Simulador: o responsável "vira cliente" para testar o bot e demonstrar o atendimento.
  .get("/simulator/contacts", async (c) => c.json({ contacts: await simulatorContacts() }))

  .get("/simulator/thread", validate("query", z.object({ phone: z.string().min(8) })), async (c) =>
    c.json({ messages: await simulatorThread(c.req.valid("query").phone) }))

  .post(
    "/simulator/messages",
    validate("json", z.object({ phone: z.string().min(8), name: z.string().trim().max(80).optional(), text: z.string().trim().min(1).max(2000), useDraft: z.boolean().optional() })),
    async (c) => {
      const b = c.req.valid("json");
      const result = await handleInbound(b);
      return c.json({ ...result, messages: await simulatorThread(b.phone) }, 201);
    },
  )

  .get("/:id", async (c) => {
    const id = idParam(c.req.param("id"));
    const detail = await getConversation(id);
    await markRead(id);
    return c.json(detail);
  })

  .post("/:id/messages", validate("json", z.object({ body: z.string().trim().min(1).max(2000) })), async (c) => {
    const id = idParam(c.req.param("id"));
    await agentReply(id, currentUser(c), c.req.valid("json").body);
    return c.json(await getConversation(id), 201);
  })

  .post("/:id/notes", validate("json", z.object({ body: z.string().trim().min(1).max(1000) })), async (c) => {
    const id = idParam(c.req.param("id"));
    await addNote(id, currentUser(c), c.req.valid("json").body);
    return c.json(await getConversation(id), 201);
  })

  .post("/:id/assume", async (c) => {
    const id = idParam(c.req.param("id"));
    await assume(id, currentUser(c));
    return c.json(await getConversation(id));
  })

  .post("/:id/release", async (c) => {
    const id = idParam(c.req.param("id"));
    await releaseToBot(id, currentUser(c));
    return c.json(await getConversation(id));
  })

  .post("/:id/pending/approve", validate("json", z.object({ messageId: z.number().int().positive().optional(), body: z.string().trim().min(1).max(2000).optional() })), async (c) => {
    const id = idParam(c.req.param("id"));
    const b = c.req.valid("json");
    await approvePending(id, currentUser(c), b.messageId, b.body);
    return c.json(await getConversation(id));
  })

  .post("/:id/pending/discard", validate("json", z.object({ messageId: z.number().int().positive().optional() })), async (c) => {
    const id = idParam(c.req.param("id"));
    await discardPending(id, currentUser(c), c.req.valid("json").messageId);
    return c.json(await getConversation(id));
  })

  .post("/:id/messages/:messageId/rating", validate("json", z.object({ rating: z.enum(["good", "bad"]).nullable(), note: z.string().trim().max(500).optional() })), async (c) => {
    const id = idParam(c.req.param("id"));
    const b = c.req.valid("json");
    await rateMessage(id, idParam(c.req.param("messageId")), currentUser(c), b.rating, b.note);
    return c.json(await getConversation(id));
  })

  .patch("/:id/review", validate("json", z.object({ review: z.enum(["ok", "corrigida", "problema"]).nullable(), note: z.string().trim().max(500).optional() })), async (c) => {
    const id = idParam(c.req.param("id"));
    const b = c.req.valid("json");
    await reviewConversation(id, currentUser(c), b.review, b.note);
    return c.json(await getConversation(id));
  })

  .patch("/:id/stage", validate("json", z.object({ stage: z.enum(STAGES), lostReason: z.string().max(200).optional() })), async (c) => {
    const id = idParam(c.req.param("id"));
    const b = c.req.valid("json");
    await setStage(id, currentUser(c), b.stage, b.lostReason);
    return c.json(await getConversation(id));
  })

  .patch(
    "/:id/contact",
    validate("json", z.object({ name: z.string().trim().min(2).max(80).optional(), businessName: z.string().trim().max(120).nullable().optional(), notes: z.string().trim().max(1000).nullable().optional() })),
    async (c) => {
      const id = idParam(c.req.param("id"));
      await updateContact(id, c.req.valid("json"));
      return c.json(await getConversation(id));
    },
  )

  .post(
    "/:id/order",
    validate("json", z.object({
      items: z.array(z.object({ productId: z.number().int().positive(), mode: z.enum(["unit", "box"]), quantity: z.number().int().min(1).max(10_000) })).min(1),
      discountCents: z.number().int().min(0).default(0),
      cep: cepSchema,
      address: addressSchema,
      notes: z.string().max(500).optional(),
    })),
    async (c) => {
      const id = idParam(c.req.param("id"));
      const order = await orderFromConversation(id, currentUser(c), c.req.valid("json"));
      return c.json({ order, ...(await getConversation(id)) }, 201);
    },
  );
