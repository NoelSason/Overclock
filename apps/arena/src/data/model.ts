/** Arena domain model. Three independent applications, each with its own database. */

export type CustomerStatus = "active" | "on_hold" | "vip";
export type OrderStatus = "processing" | "shipped" | "delivered" | "refunded" | "cancelled";
export type TicketCategory = "shipping" | "refund" | "damage" | "billing" | "general";
export type TicketStatus = "open" | "pending" | "resolved" | "escalated";
export type TicketOwner = "Unassigned" | "Tier 1" | "Tier 2" | "Billing";

export interface Customer {
  id: string;
  name: string;
  email: string;
  phone: string;
  city: string;
  status: CustomerStatus;
  updated_at: string;
  version: number;
}

export interface Order {
  id: string;
  customer_id: string;
  customer_email: string;
  status: OrderStatus;
  total: number;
  tracking: string;
  placed_at: string;
  review_flag: 0 | 1;
  review_reason: string;
  updated_at: string;
  version: number;
}

export interface Ticket {
  id: string;
  order_id: string;
  customer_email: string;
  subject: string;
  body: string;
  category: TicketCategory;
  status: TicketStatus;
  owner: TicketOwner;
  updated_at: string;
  version: number;
}

export interface Note {
  id: number;
  ticket_id: string;
  body: string;
  created_at: string;
}

export interface Dataset {
  customers: Customer[];
  orders: Order[];
  tickets: Ticket[];
  notes: Note[];
}

export const CUSTOMER_STATUSES: CustomerStatus[] = ["active", "on_hold", "vip"];
export const ORDER_STATUSES: OrderStatus[] = ["processing", "shipped", "delivered", "refunded", "cancelled"];
export const TICKET_CATEGORIES: TicketCategory[] = ["shipping", "refund", "damage", "billing", "general"];
export const TICKET_STATUSES: TicketStatus[] = ["open", "pending", "resolved", "escalated"];
export const TICKET_OWNERS: TicketOwner[] = ["Unassigned", "Tier 1", "Tier 2", "Billing"];

export function cloneDataset(d: Dataset): Dataset {
  return structuredClone(d);
}
