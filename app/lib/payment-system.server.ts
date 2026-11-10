export interface Payout {
  refundId: number;
  amount: number;
}

export type PayoutOutcome =
  | { status: "sent" }
  | { status: "failed"; reason: string };

export type PayoutResult = { refundId: number } & PayoutOutcome;

export type PayoutResultHandler = (result: PayoutResult) => void;

export interface PaymentSystem {
  sendPayout(payout: Payout): void;
  onResult(handler: PayoutResultHandler): void;
}

const DEFAULT_SETTLEMENT_DELAY_MS = 30_000;
const DEV_FAILURE_REASON = "Payout declined by the Payment System";

export class MockPaymentSystem implements PaymentSystem {
  private readonly delayMs: number;
  private handler: PayoutResultHandler | null = null;
  private scriptedOutcomes: PayoutOutcome[] = [];
  private nextPayoutFails = false;

  constructor({ delayMs = DEFAULT_SETTLEMENT_DELAY_MS }: { delayMs?: number } = {}) {
    this.delayMs = delayMs;
  }

  onResult(handler: PayoutResultHandler) {
    this.handler = handler;
  }

  scriptOutcome(outcome: PayoutOutcome) {
    this.scriptedOutcomes.push(outcome);
  }

  failNextPayout(fail: boolean) {
    this.nextPayoutFails = fail;
  }

  isNextPayoutFailing() {
    return this.nextPayoutFails;
  }

  sendPayout(payout: Payout) {
    const outcome = this.takeOutcome();
    setTimeout(() => {
      this.handler?.({ refundId: payout.refundId, ...outcome });
    }, this.delayMs);
  }

  private takeOutcome(): PayoutOutcome {
    if (this.nextPayoutFails) {
      this.nextPayoutFails = false;
      return { status: "failed", reason: DEV_FAILURE_REASON };
    }
    return this.scriptedOutcomes.shift() ?? { status: "sent" };
  }
}

let paymentSystem: PaymentSystem | null = null;

export function getPaymentSystem(): PaymentSystem {
  paymentSystem ??= new MockPaymentSystem({ delayMs: delayFromEnv() });
  return paymentSystem;
}

// Pass null to fall back to the default mock on the next getPaymentSystem().
export function setPaymentSystem(system: PaymentSystem | null) {
  paymentSystem = system;
}

// DevUI toggle: only the mock can be told to fail its next payout.
export function setFailNextPayout(fail: boolean) {
  const system = getPaymentSystem();
  if (system instanceof MockPaymentSystem) system.failNextPayout(fail);
}

export function isFailingNextPayout(): boolean {
  const system = getPaymentSystem();
  return system instanceof MockPaymentSystem && system.isNextPayoutFailing();
}

function delayFromEnv(): number | undefined {
  const raw = process.env.PAYMENT_SYSTEM_DELAY_MS;
  if (!raw) return undefined;
  const delayMs = Number(raw);
  return Number.isFinite(delayMs) && delayMs >= 0 ? delayMs : undefined;
}
