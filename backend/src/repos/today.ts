import { config } from "../config";
import { db } from "../db";
import { needsYou } from "./conversations";
import { inventoryOverview } from "./inventory";

// Tela "Hoje" do painel: o que a equipe precisa fazer agora, do mais urgente para o menos.

export async function todayOverview() {
  const tz = config().TZ_BUSINESS;
  const [today] = await db()`select (now() at time zone ${tz})::date::text as d`;
  const day = today.d as string;

  const [toSeparate, deliveries, payments, conversations, inventory, questions, sales] = await Promise.all([
    // Pagos e ainda não separados: o próximo trabalho da câmara fria.
    db()`
      select o.code, o.status, o.total_cents as "totalCents", o.scheduled_delivery::text as "scheduledDelivery",
             u.name as customer, dr.name as region
      from orders o join users u on u.id = o.user_id left join delivery_regions dr on dr.id = o.delivery_region_id
      where o.status in ('confirmed', 'preparing')
      order by o.scheduled_delivery nulls last, o.created_at limit 50`,
    // Rotas de hoje (o que precisa sair ou já saiu).
    db()`
      select o.code, o.status, u.name as customer, dr.name as region
      from orders o join users u on u.id = o.user_id left join delivery_regions dr on dr.id = o.delivery_region_id
      where o.scheduled_delivery = ${day}::date and o.status in ('confirmed', 'preparing', 'in_transit')
      order by dr.name, o.code`,
    db()`
      select p.provider, p.amount_cents as "amountCents", p.expires_at as "expiresAt", o.code
      from payments p join orders o on o.id = p.order_id
      where p.status = 'pending' order by p.expires_at limit 50`,
    needsYou(),
    inventoryOverview(),
    db()`select count(*)::int as open from bot_questions where status = 'open'`,
    db()`
      select count(*)::int as orders, coalesce(sum(total_cents), 0)::float8 as cents
      from orders where status <> 'cancelled' and (created_at at time zone ${tz})::date = ${day}::date`,
  ]);

  const critical = inventory.products.filter((p) => p.status === "falta" || p.expiry || p.status === "zerado" || p.status === "baixo");
  return {
    date: day,
    sales: { orders: sales[0].orders as number, cents: Number(sales[0].cents) },
    separate: {
      confirmed: toSeparate.filter((o: any) => o.status === "confirmed").length,
      preparing: toSeparate.filter((o: any) => o.status === "preparing").length,
      items: toSeparate.slice(0, 6),
    },
    deliveries: { count: deliveries.length, inTransit: deliveries.filter((o: any) => o.status === "in_transit").length, items: deliveries.slice(0, 6) },
    payments: { count: payments.length, items: payments.slice(0, 5) },
    conversations,
    stock: {
      shortage: inventory.summary.withShortage,
      belowMinimum: inventory.summary.belowMinimum,
      expiring: inventory.summary.expiring,
      items: critical.slice(0, 6).map((p) => ({ id: p.id, name: p.name, status: p.status, expiry: p.expiry, available: p.available, shortUnits: p.shortUnits, expiredUnits: p.expiredUnits, expiringUnits: p.expiringUnits })),
    },
    questions: { open: questions[0].open as number },
  };
}
