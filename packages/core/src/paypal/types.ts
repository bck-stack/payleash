import type { Money } from "../money.js";

/**
 * Normalised PayPal ground truth. These are the only facts the firewall trusts.
 * Raw API responses are mapped into these shapes by `RestPayPalReader`.
 */
export interface KnownFigure {
  label: string;
  money: Money;
}

export interface CaptureTruth {
  id: string;
  status: string;
  amount: Money;
  /** Total already refunded, when PayPal shows it. */
  refundedMinor?: number;
  /** amount - refunded. Undefined only when PayPal does not reveal the refund balance. */
  remainingMinor?: number;
  createdAt?: Date;
  orderId?: string;
  buyerEmail?: string;
  /** Amounts PayPal itself shows for this order (capture total, remaining, line items, shipping). */
  figures: KnownFigure[];
}

export interface OrderTruth {
  id: string;
  status: string;
  amount?: Money;
  createdAt?: Date;
  buyerEmail?: string;
  captureIds: string[];
  figures: KnownFigure[];
}

export interface DisputeMessage {
  postedBy?: string;
  content: string;
}

export interface DisputeTruth {
  id: string;
  status: string;
  amount?: Money;
  createdAt?: Date;
  buyerEmail?: string;
  /** Text written by the other party. Untrusted; the proxy registers it as such. */
  messages: DisputeMessage[];
}

export interface InvoiceTruth {
  id: string;
  status: string;
  amount?: Money;
  paidMinor?: number;
  createdAt?: Date;
  recipients: string[];
  figures: KnownFigure[];
}

export interface SubscriptionTruth {
  id: string;
  status: string;
  subscriberEmail?: string;
  planId?: string;
  createdAt?: Date;
}

/** Read-only access to PayPal. Each method returns null when the id does not exist. */
export interface PayPalReader {
  getCapture(id: string): Promise<CaptureTruth | null>;
  getOrder(id: string): Promise<OrderTruth | null>;
  getDispute(id: string): Promise<DisputeTruth | null>;
  getInvoice(id: string): Promise<InvoiceTruth | null>;
  getSubscription(id: string): Promise<SubscriptionTruth | null>;
}

export class PayPalReadError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "PayPalReadError";
  }
}
