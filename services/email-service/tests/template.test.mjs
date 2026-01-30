import assert from "node:assert/strict";
import { renderEmail } from "../services/templates/templateEngine.js";

const { html } = renderEmail({
  templateId: "order_placed_customer",
  variables: {
    customerName: "Test",
    orderNumber: "ORD-1",
    orderLink: "https://example.com",
    brandLogoUrl: "https://example.com/logo.png",
  },
});

assert.ok(html.includes("ORD-1"));
console.log("template tests passed");
