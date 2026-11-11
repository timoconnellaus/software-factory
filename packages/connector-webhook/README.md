# @software-factory/connector-webhook

The provider-neutral half of an inbound webhook connector (ADR 0010): read a delivery's raw body,
check its HMAC-SHA256 signature in constant time (`readDelivery`, `verifySignature`), and name it
(`deliveryId`, `event`) so the caller can dedupe it. An unset secret refuses every delivery.

Dedupe is an operation, not a write here: the caller checks `core_connector_events` for the
delivery id, handles the event, then records it with `connector.receive`. GitHub's events are
mapped to operations by [`@software-factory/connector-github`](../connector-github/).
