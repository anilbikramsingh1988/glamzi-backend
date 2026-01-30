import PDFDocument from "pdfkit";
import { client } from "../dbConfig.js";
import { saveReport } from "../services/reports/reportStorage.js";
import { emitDomainEvent } from "../services/events/emitDomainEvent.js";

const db = client.db(process.env.DB_NAME || "glamzi_ecommerce");
const Users = db.collection("users");
const Invoices = db.collection("invoices");

function dateKeyKathmandu(date = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kathmandu",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function buildPdf({ sellerName, dateKey, totals }) {
  const doc = new PDFDocument({ size: "A4", margin: 40 });
  const chunks = [];
  doc.on("data", (c) => chunks.push(c));
  doc.fontSize(18).text("Glamzi Settlement Report", { align: "left" });
  doc.moveDown(0.5);
  doc.fontSize(12).text(`Seller: ${sellerName}`);
  doc.text(`Date: ${dateKey}`);
  doc.moveDown();
  doc.fontSize(12).text(`Gross: Rs. ${totals.gross}`);
  doc.text(`Commission: Rs. ${totals.commission}`);
  doc.text(`Net payout: Rs. ${totals.net}`);
  doc.end();
  return new Promise((resolve) => {
    doc.on("end", () => resolve(Buffer.concat(chunks)));
  });
}

async function run() {
  const dateKey = process.env.REPORT_DATE_KEY || dateKeyKathmandu(new Date());

  const sellers = await Users.find({ role: "seller" })
    .project({ _id: 1, storeName: 1, name: 1 })
    .toArray();

  for (const seller of sellers) {
    const sellerId = String(seller._id);
    const start = new Date(`${dateKey}T00:00:00+05:45`);
    const end = new Date(`${dateKey}T23:59:59+05:45`);

    const invoices = await Invoices.find({
      sellerId,
      createdAt: { $gte: start, $lte: end },
    })
      .project({ totals: 1, sellerTotals: 1, grossTotal: 1, commissionAmount: 1 })
      .toArray();

    const totals = invoices.reduce(
      (acc, inv) => {
        const gross =
          inv?.sellerTotals?.subtotalBase ??
          inv?.totals?.gross ??
          inv?.grossTotal ??
          0;
        const commission =
          inv?.totals?.commission ??
          inv?.commissionAmount ??
          0;
        const net =
          inv?.sellerTotals?.grandTotal ??
          inv?.totals?.net ??
          gross - commission;
        acc.gross += Number(gross || 0);
        acc.commission += Number(commission || 0);
        acc.net += Number(net || 0);
        return acc;
      },
      { gross: 0, commission: 0, net: 0 }
    );

    const sellerName = seller.storeName || seller.name || "Seller";
    const pdfBuffer = await buildPdf({ sellerName, dateKey, totals });
    const key = `settlements/${sellerId}/${dateKey}.pdf`;
    const { url } = await saveReport({ buffer: pdfBuffer, key });

    const attachment = url
      ? null
      : pdfBuffer.toString("base64");

    await emitDomainEvent({
      type: "settlement.seller_report_ready",
      actor: { role: "system" },
      refs: { sellerId },
      payload: {
        dateKey,
        reportUrl: url || "",
        attachment,
        summary: totals,
      },
      dedupeKey: `settlement.seller_report_ready:${sellerId}:${dateKey}`,
    });
  }

  // eslint-disable-next-line no-console
  console.log(`[settlement-report] generated for ${dateKey}`);
  process.exit(0);
}

run().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("generateSellerSettlementReports failed:", err);
  process.exit(1);
});
