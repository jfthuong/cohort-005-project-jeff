# Refunds go through a Payment System that pushes the result back

Cadence has no real payment provider yet, but the Refund lifecycle (Pending → Issued / Failed) has to work end to end. Cadence therefore only talks to a small `PaymentSystem` interface: it asks the Payment System to send a Refund, and the Payment System later calls back with the result (Issued or Failed, plus a failure reason). For now the only implementation is an in-process mock. It settles each Refund after a delay: by default it succeeds after about 30 seconds in development, and a DevUI toggle makes the next payout fail. Tests inject the mock, script each outcome, and move time forward with fake timers, so they never wait on a real clock.

## Considered Options

- **Pull (Cadence asks for the status when a page loads)**: rejected. Real payment providers report results with webhooks, so pulling would mean redesigning the flow once a real one is plugged in.
- **Admins mark Refunds Issued or Failed by hand**: rejected. The result should come from the system that moves the money, not from a person's claim. Admins can only retry a Failed Refund.

## Consequences

- Every attempt to send a Refund is recorded with its time and its result, so Admins can see repeated failures before retrying.
- Swapping in a real provider means writing one new `PaymentSystem` implementation plus its webhook endpoint. The domain code stays the same.
