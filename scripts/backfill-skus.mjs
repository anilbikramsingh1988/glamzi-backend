import { getDB, client } from "../dbConfig.js";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const limitArgIndex = args.indexOf("--limit");
const limit =
  limitArgIndex !== -1 ? Number(args[limitArgIndex + 1]) || 0 : 0;

const SKU_CATEGORY_CODES = [
  { keywords: ["makeup", "cosmetic"], code: "MKP" },
  { keywords: ["skin", "skincare"], code: "SKN" },
  { keywords: ["hair", "haircare"], code: "HAR" },
  { keywords: ["fragrance", "perfume"], code: "FRG" },
  { keywords: ["body", "bath"], code: "BDY" },
  { keywords: ["men", "groom"], code: "MEN" },
  { keywords: ["dress"], code: "DRS" },
  { keywords: ["saree"], code: "SRE" },
  { keywords: ["cardigan", "sweater"], code: "CRD" },
  { keywords: ["lipstick", "lip"], code: "LIP" },
  { keywords: ["moisturizer"], code: "MST" },
  { keywords: ["cleanser"], code: "CLN" },
  { keywords: ["serum"], code: "SRM" },
  { keywords: ["toner"], code: "TNR" },
  { keywords: ["mask"], code: "MSK" },
  { keywords: ["shampoo"], code: "SHP" },
  { keywords: ["conditioner"], code: "CND" },
];

const SKU_COLOR_CODES = {
  black: "BLK",
  white: "WHT",
  red: "RED",
  blue: "BLU",
  green: "GRN",
  yellow: "YLW",
  pink: "PNK",
  purple: "PUR",
  orange: "ORG",
  brown: "BRN",
  beige: "BEG",
  gray: "GRY",
  grey: "GRY",
  gold: "GLD",
  silver: "SLV",
};

const SKU_SIZE_CODES = ["XS", "S", "M", "L", "XL", "XXL", "XXXL"];

function cleanSkuSegment(value, maxLen = 5) {
  const cleaned = String(value || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
  if (!cleaned) return "";
  return cleaned.slice(0, maxLen);
}

function normalizeSkuValue(value) {
  const cleaned = String(value || "")
    .toUpperCase()
    .replace(/[^A-Z0-9-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return cleaned;
}

function makeCodeFromWords(text, fallback = "GLZ", maxLen = 4) {
  const normalized = String(text || "").replace(/[^A-Za-z0-9 ]/g, " ").trim();
  if (!normalized) return fallback;
  const parts = normalized.split(/\s+/).filter(Boolean);
  if (parts.length === 1) {
    return cleanSkuSegment(parts[0], maxLen) || fallback;
  }
  const code = parts.map((p) => p[0]).join("");
  return cleanSkuSegment(code, maxLen) || fallback;
}

function resolveCategoryCode(categoryName = "") {
  const lower = String(categoryName || "").toLowerCase();
  for (const entry of SKU_CATEGORY_CODES) {
    if (entry.keywords.some((k) => lower.includes(k))) {
      return entry.code;
    }
  }
  return makeCodeFromWords(categoryName, "GEN", 4);
}

function resolveBrandCode(brandName, sellerName) {
  if (brandName && String(brandName).trim()) {
    return makeCodeFromWords(brandName, "GLZ", 4);
  }
  if (sellerName && String(sellerName).trim()) {
    return makeCodeFromWords(sellerName, "GLZ", 4);
  }
  return "GLZ";
}

function resolveAttributeCodes(source = "") {
  const lower = String(source || "").toLowerCase();
  const color = Object.keys(SKU_COLOR_CODES).find((key) => lower.includes(key));
  const size = SKU_SIZE_CODES.find((code) => new RegExp(`\\b${code}\\b`, "i").test(source));
  const segments = [];
  if (color) segments.push(SKU_COLOR_CODES[color]);
  if (size) segments.push(size);
  return segments;
}

async function generateUniqueSku(baseSegments, productsCollection, reservedSkus, maxTries = 12) {
  const base = baseSegments.filter(Boolean).join("-");
  for (let i = 0; i < maxTries; i += 1) {
    const suffix = String(Math.floor(100 + Math.random() * 900));
    const sku = `${base}-${suffix}`;
    if (reservedSkus.has(sku)) continue;
    const exists = await productsCollection.findOne({ sku });
    if (!exists) {
      reservedSkus.add(sku);
      return sku;
    }
  }
  let fallback = `${base}-${String(Date.now()).slice(-4)}`;
  while (reservedSkus.has(fallback)) {
    fallback = `${base}-${String(Date.now()).slice(-4)}`;
  }
  reservedSkus.add(fallback);
  return fallback;
}

async function buildProductSku({
  brand,
  category,
  productName,
  variantName,
  sellerName,
  productsCollection,
  reservedSkus,
}) {
  const brandCode = resolveBrandCode(brand, sellerName);
  const categoryCode = resolveCategoryCode(category);
  const productCode = makeCodeFromWords(productName, "PRD", 4);
  const attributeCodes = resolveAttributeCodes(variantName || "");
  const segments = [brandCode, categoryCode, productCode, ...attributeCodes].filter(Boolean);
  return generateUniqueSku(segments, productsCollection, reservedSkus);
}

async function main() {
  const db = await getDB();
  const Products = db.collection("products");

  const cursor = Products.find({ deleted: { $ne: true } });
  const reservedSkus = new Set();
  const bulkOps = [];
  let processed = 0;
  let updatedProducts = 0;
  let updatedVariants = 0;

  for await (const product of cursor) {
    processed += 1;
    if (limit && processed > limit) break;

    const productName = product.name || product.title || "Product";
    const category = product.category || "Uncategorized";
    const brand = product.brand || "";

    let needsUpdate = false;
    const update = {};

    if (!product.sku || !String(product.sku).trim()) {
      const generatedSku = await buildProductSku({
        brand,
        category,
        productName,
        variantName: "",
        sellerName: "",
        productsCollection: Products,
        reservedSkus,
      });
      update.sku = generatedSku;
      needsUpdate = true;
      updatedProducts += 1;
    }

    if (Array.isArray(product.variants) && product.variants.length > 0) {
      let variantsUpdated = false;
      const nextVariants = await Promise.all(
        product.variants.map(async (variant) => {
          const currentSku = normalizeSkuValue(variant?.sku);
          if (currentSku) return variant;
          const generatedSku = await buildProductSku({
            brand,
            category,
            productName,
            variantName: variant?.name || "",
            sellerName: "",
            productsCollection: Products,
            reservedSkus,
          });
          variantsUpdated = true;
          updatedVariants += 1;
          return { ...variant, sku: generatedSku };
        })
      );
      if (variantsUpdated) {
        update.variants = nextVariants;
        needsUpdate = true;
      }
    }

    if (needsUpdate) {
      if (!dryRun) {
        bulkOps.push({
          updateOne: {
            filter: { _id: product._id },
            update: { $set: update },
          },
        });
      }
    }

    if (bulkOps.length >= 200) {
      await Products.bulkWrite(bulkOps, { ordered: false });
      bulkOps.length = 0;
    }
  }

  if (bulkOps.length) {
    await Products.bulkWrite(bulkOps, { ordered: false });
  }

  console.log(
    `[SKU Backfill] processed=${processed} updatedProducts=${updatedProducts} updatedVariants=${updatedVariants} dryRun=${dryRun}`
  );
}

main()
  .catch((err) => {
    console.error("SKU backfill failed:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    try {
      await client.close();
    } catch {
      // ignore
    }
  });
