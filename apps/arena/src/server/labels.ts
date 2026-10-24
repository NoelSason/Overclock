import {
  CUSTOMER_STATUSES,
  ORDER_STATUSES,
  TICKET_CATEGORIES,
  TICKET_OWNERS,
  TICKET_STATUSES,
  type CustomerStatus,
  type OrderStatus,
  type TicketCategory,
  type TicketOwner,
  type TicketStatus,
} from "../data/model";

/** Human labels for stored enum values. Select options use `value` = enum, text = label. */

export const CUSTOMER_STATUS_LABELS: Record<CustomerStatus, string> = { active: "Active", on_hold: "On hold", vip: "VIP" };
export const ORDER_STATUS_LABELS: Record<OrderStatus, string> = {
  processing: "Processing",
  shipped: "Shipped",
  delivered: "Delivered",
  refunded: "Refunded",
  cancelled: "Cancelled",
};
export const TICKET_CATEGORY_LABELS: Record<TicketCategory, string> = { shipping: "Shipping", refund: "Refund", damage: "Damage", billing: "Billing", general: "General" };
export const TICKET_STATUS_LABELS: Record<TicketStatus, string> = { open: "Open", pending: "Pending", resolved: "Resolved", escalated: "Escalated" };
export const TICKET_OWNER_LABELS: Record<TicketOwner, string> = { Unassigned: "Unassigned", "Tier 1": "Tier 1", "Tier 2": "Tier 2", Billing: "Billing" };

export interface EnumSpec<T extends string> {
  values: readonly T[];
  labels: Record<T, string>;
}

export const CUSTOMER_STATUS: EnumSpec<CustomerStatus> = { values: CUSTOMER_STATUSES, labels: CUSTOMER_STATUS_LABELS };
export const ORDER_STATUS: EnumSpec<OrderStatus> = { values: ORDER_STATUSES, labels: ORDER_STATUS_LABELS };
export const TICKET_CATEGORY: EnumSpec<TicketCategory> = { values: TICKET_CATEGORIES, labels: TICKET_CATEGORY_LABELS };
export const TICKET_STATUS: EnumSpec<TicketStatus> = { values: TICKET_STATUSES, labels: TICKET_STATUS_LABELS };
export const TICKET_OWNER: EnumSpec<TicketOwner> = { values: TICKET_OWNERS, labels: TICKET_OWNER_LABELS };

/** Strict membership check for a submitted enum value. */
export function isEnum<T extends string>(spec: EnumSpec<T>, v: unknown): v is T {
  return typeof v === "string" && (spec.values as readonly string[]).includes(v);
}

/** Lenient parse: accepts the enum value or its human label, case-insensitive, `_`/space-insensitive. */
export function parseEnumLenient<T extends string>(spec: EnumSpec<T>, input: string): T | undefined {
  const norm = (s: string) => s.trim().toLowerCase().replace(/[\s_-]+/g, " ");
  const n = norm(input);
  if (!n) return undefined;
  for (const v of spec.values) if (norm(v) === n || norm(spec.labels[v]) === n) return v;
  return undefined;
}

export function labelOf<T extends string>(spec: EnumSpec<T>, v: string): string {
  return isEnum(spec, v) ? spec.labels[v] : v;
}
