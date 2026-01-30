# Glamzi Email Routing Service

Internal email routing microservice for Glamzi.

## Run locally

```bash
npm install
cp .env.example .env
npm run ensure-indexes
npm run dev
```

Worker:

```bash
npm run worker
```

## Enqueue example

```bash
curl -X POST http://localhost:8088/api/email/enqueue \
  -H "Content-Type: application/json" \
  -H "x-internal-token: YOUR_TOKEN" \
  -d '{
    "type": "order.placed.customer",
    "priority": "high",
    "idempotencyKey": "order.placed:ORD-123:customer",
    "fromKey": "orders",
    "to": ["customer@example.com"],
    "templateId": "order_placed_customer",
    "subject": "Your Glamzi order is confirmed",
    "variables": {
      "customerName": "Anil",
      "orderNumber": "ORD-123",
      "orderLink": "https://glamzibeauty.com/orders",
      "brandLogoUrl": "https://glamzibeauty.com/favicon.png"
    },
    "meta": {
      "sourceService": "glamzi-ecommerce",
      "traceId": "trace-1",
      "refs": { "orderId": "123" }
    }
  }'
```

## Health

- `GET /health`
- `GET /ready`

## Admin template management

All template endpoints require the same `x-internal-token` header.

- `GET /api/admin/templates`
- `POST /api/admin/templates`
- `GET /api/admin/templates/:templateKey/versions`
- `POST /api/admin/templates/:templateKey/versions`
- `GET /api/admin/templates/:templateKey/versions/:version/preview`
- `POST /api/admin/templates/:templateKey/versions/:version/test-send`
- `POST /api/admin/templates/:templateKey/versions/:version/publish`
- `POST /api/admin/templates/:templateKey/versions/:version/rollback`

## Notes

- All endpoints require `x-internal-token`.
- Idempotency enforced with `idempotencyKey`.
- Worker handles retries with backoff.
