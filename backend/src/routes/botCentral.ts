import { Hono } from "hono";
import { z } from "zod";
import { adminAccess, currentUser } from "../lib/auth";
import { badRequest } from "../lib/errors";
import type { AppEnv } from "../lib/types";
import { validate } from "../lib/validate";
import {
  answerQuestion, centralOverview, discardDraft, ignoreQuestion, listQuestions, publish, qualityReport, restoreVersion, saveDraft, teach,
} from "../repos/botCentral";

// Painel → Robô: os donos editam o robô (rascunho), testam no Simulador e publicam.

const text = (max: number) => z.string().trim().max(max);
const keywords = z.array(z.string().trim().min(2).max(40)).max(20);

const configSchema = z.object({
  persona: z.object({
    name: text(40),
    tone: z.enum(["acolhedor", "formal", "descontraido"]),
    greeting: text(300).min(2),
    emojis: z.boolean(),
  }),
  storeInfo: text(4000).min(10),
  faqs: z.array(z.object({
    id: z.string().min(1).max(40),
    question: text(200).min(3),
    answer: text(1000).min(2),
    keywords: keywords.min(1, "Cada pergunta frequente precisa de ao menos uma palavra-chave"),
  })).max(100),
  products: z.record(z.string().max(40), z.object({
    fabrication: text(800), pairing: text(500), storage: text(500), notes: text(500),
  })),
  rules: z.object({
    maxDiscountPct: z.number().int().min(0).max(30),
    minOrderCents: z.number().int().min(0).max(1_000_000),
    upsell: z.boolean(),
    freeShippingNudge: z.boolean(),
    handoffKeywords: keywords,
    extraInstructions: text(2000),
  }),
});

const idParam = (v: string) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) throw badRequest("Identificador inválido");
  return n;
};

export const botCentralRoutes = new Hono<AppEnv>()
  .use(adminAccess)
  .get("/", async (c) => c.json(await centralOverview()))
  .put("/draft", validate("json", configSchema), async (c) => c.json(await saveDraft(c.req.valid("json"))))
  .post("/publish", async (c) => c.json(await publish(currentUser(c).name)))
  .post("/discard", async (c) => c.json(await discardDraft()))
  .post("/versions/:index/restore", async (c) => c.json(await restoreVersion(idParam(c.req.param("index")))))
  .get("/questions", validate("query", z.object({ status: z.enum(["open", "answered", "ignored"]).default("open") })), async (c) =>
    c.json({ questions: await listQuestions(c.req.valid("query").status) }))
  .post("/questions/:id/answer", validate("json", z.object({ question: text(200).min(3), answer: text(1000).min(2), keywords: keywords.min(1) })), async (c) =>
    c.json(await answerQuestion(idParam(c.req.param("id")), c.req.valid("json"), currentUser(c).id)))
  // "Ensinar ao robô" a partir de uma resposta da equipe ou de uma correção.
  .post("/teach", validate("json", z.object({ question: text(200).min(3), answer: text(1000).min(2), keywords: keywords.min(1) })), async (c) =>
    c.json(await teach(c.req.valid("json"))))
  .get("/quality", validate("query", z.object({ days: z.coerce.number().int().min(1).max(365).default(30) })), async (c) =>
    c.json(await qualityReport(c.req.valid("query").days)))
  .post("/questions/:id/ignore", async (c) => {
    await ignoreQuestion(idParam(c.req.param("id")));
    return c.json({ ok: true });
  });
