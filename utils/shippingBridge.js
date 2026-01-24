// utils/shippingBridge.js
import axios from "axios";
import { RETURN_STATUS } from "./returnsStatus.js";

/**
 * Shipping Bridge (Fire-and-Forget)
 * - Called by ordersRoutes on seller transition to ready_to_ship
 * - Books shipment in shipping service and persists tracking into Orders.sellerFulfillment.{sellerId}.shipping.*
 *
 * ALIGNMENT GUARANTEES (Forward + Return):
 * - Uses ONE partner namespace everywhere via SHIPPING_PARTNER (env-driven)
 * - Sends booking-time hub/zone resolver hints consistently:
 *    meta.zoneResolve=true + meta.zoneHints + to.locality (and from/to locality when available)
 * - Treats lat/lng value 0 as "missing" (never sent)
 * - Booking payload compatibility:
 *    A) legacy: { customer, items, ... }   (sent when items exist)
 *    B) bridge: { to, from, parcels, ... } (always sent)
 * - ReturnFlow enforcement:
 *    - buildShippingPayloadFromOrder includes top-level returnFlow when returnFlow=true
 *    - bookReturnShipment ALWAYS sends returnFlow=true + structured reference.returnId
 *
 * ENV:
 *  - SHIPPING_SERVICE_URL        (default: http://localhost:4001)
 *  - SHIPPING_INTERNAL_TOKEN     (optional)
 *  - SHIPPING_PARTNER            (default: "everestx")
 *  - SHIPPING_TIMEOUT_MS         (default: 12000)
 *
 *  Seller pickup fallback:
 *  - SHIPPING_PICKUP_NAME
 *  - SHIPPING_PICKUP_PHONE
 *  - SHIPPING_PICKUP_ADDRESS
 *  - SHIPPING_PICKUP_CITY
 *  - SHIPPING_PICKUP_DISTRICT
 *  - SHIPPING_PICKUP_PROVINCE
 *  - SHIPPING_PICKUP_WARD
 *  - SHIPPING_PICKUP_POSTAL_CODE
 *  - SHIPPING_PICKUP_LAT
 *  - SHIPPING_PICKUP_LNG
 */

const SHIPPING_SERVICE_URL_RAW = (process.env.SHIPPING_SERVICE_URL || "http://localhost:4001").trim();
const SHIPPING_SERVICE_URL = SHIPPING_SERVICE_URL_RAW.replace(/\/+$/, "");
const SHIPPING_INTERNAL_TOKEN = (process.env.SHIPPING_INTERNAL_TOKEN || "").trim();
const SHIPPING_PARTNER = (process.env.SHIPPING_PARTNER || "everestx").trim() || "everestx";
const SHIPPING_TIMEOUT_MS = Number(process.env.SHIPPING_TIMEOUT_MS || 12000);

const MAX_ATTEMPTS = 3;

/* =========================
   Small helpers
========================= */

function now() {
  return new Date();
}

function safeStr(v) {
  return typeof v === "string" ? v.trim() : "";
}

function safeNum(v, def = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

function truncateStr(s, max = 400) {
  const v = typeof s === "string" ? s : "";
  if (!v) return null;
  return v.length > max ? v.slice(0, max) : v;
}

function buildSellerShippingPath(sellerIdStr) {
  return `sellerFulfillment.${sellerIdStr}.shipping`;
}

function hasExistingTracking(seg) {
  const tracking = safeStr(seg?.shipping?.trackingNumber);
  const shipmentId = safeStr(seg?.shipping?.shipmentId);
  return Boolean(tracking || shipmentId);
}

function pickFirstNonEmpty(...vals) {
  for (const v of vals) {
    const s = safeStr(v);
    if (s) return s;
  }
  return "";
}

function normalizePhone(p) {
  const s = safeStr(p);
  if (!s) return "";
  return s.replace(/[^\d+]/g, "");
}

/* ---------- geo helpers ---------- */

function toFiniteNumberOrNull(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function pickFiniteNumber(...vals) {
  for (const v of vals) {
    const n = toFiniteNumberOrNull(v);
    if (n != null) return n;
  }
  return null;
}

function isValidGeo(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return false;
  // treat 0 as "missing" (your data often has 0 defaults)
  return n !== 0;
}

function pickGeoOrNull(v) {
  return isValidGeo(v) ? Number(v) : null;
}

/* =========================================================
   HTTP semantics helpers (avoid marking 4xx as booked)
========================================================= */

function isOkStatus(status) {
  const s = Number(status) || 0;
  // 2xx = ok, 409 = idempotent duplicate (treat as ok)
  return (s >= 200 && s < 300) || s === 409;
}

function shouldRetryStatus(status) {
  const s = Number(status) || 0;
  // retry: network (0), 408 timeout, 429 rate limit, 5xx server errors
  return s === 0 || s === 408 || s === 429 || (s >= 500 && s < 600);
}

/* =========================================================
   COD helper
========================================================= */

/**
 * Compute per-seller COD amount (reasonable default):
 * - sellerSubtotalNet = Σ (final/unit) * qty
 * - allocate order-level shipping (shippingFee - shippingDiscount) proportionally by seller share of subtotal
 */
function computeSellerCodAmount(order, sellerIdStr) {
  const items = Array.isArray(order?.items) ? order.items : [];
  const sellerItems = items.filter((it) => String(it?.sellerId || "") === String(sellerIdStr));

  const sellerSubtotalNet = sellerItems.reduce((sum, it) => {
    const qty = Math.max(1, Math.floor(Number(it?.quantity) || 1));
    const lineTotal = safeNum(it?.pricing?.final ?? it?.unitPrice ?? it?.price ?? 0, 0);
    const perUnit = Number.isFinite(lineTotal) && qty > 0 ? lineTotal / qty : safeNum(it?.unitPrice ?? 0, 0);
    return sum + perUnit * qty;
  }, 0);

  const totals = order?.totals || {};
  const orderSubtotal = safeNum(totals?.discountedSubtotal ?? totals?.subtotal ?? 0, 0);
  const shipFee = safeNum(totals?.shippingFee ?? 0, 0);
  const shipDisc = safeNum(totals?.shippingDiscount ?? 0, 0);
  const shipNet = Math.max(0, shipFee - shipDisc);

  let shipAllocated = 0;
  if (shipNet > 0 && orderSubtotal > 0 && sellerSubtotalNet > 0) {
    shipAllocated = (shipNet * sellerSubtotalNet) / orderSubtotal;
  }

  const codAmount = Math.max(0, sellerSubtotalNet + shipAllocated);
  return Math.round(codAmount); // integer NPR
}

/* =========================================================
   Dropoff (to) builder (forward delivery)
========================================================= */

function buildAddressTo(order) {
  const sa = order?.shippingAddress || {};

  const name = pickFirstNonEmpty(
    sa.fullName,
    sa.name,
    sa.contactName,
    sa.recipientName,
    order?.customerName,
    order?.customer?.name
  );

  const phone = normalizePhone(pickFirstNonEmpty(sa.phone, sa.mobile, order?.customerPhone, order?.customer?.phone));

  const address = pickFirstNonEmpty(sa.tole, sa.addressLine1, sa.address, sa.street);

  const municipalityName = pickFirstNonEmpty(sa.municipalityName, sa.city, sa.municipality, sa.cityName);

  const district = pickFirstNonEmpty(sa.district, sa.districtName);
  const province = pickFirstNonEmpty(sa.province, sa.provinceName);

  const ward = sa.wardNumber != null ? String(sa.wardNumber) : sa.ward != null ? String(sa.ward) : "";

  const postalCode = pickFirstNonEmpty(sa.postalCode, sa.zip, sa.zipCode, sa.postcode);

  const locality = pickFirstNonEmpty(sa.locality, sa.area, sa.neighborhood, sa.tole);

  // dropoff geo extraction (robust alternates)
  const latRaw = pickFiniteNumber(
    sa.lat,
    sa.latitude,
    sa.location?.lat,
    sa.location?.latitude,
    sa.geo?.lat,
    order?.geo?.to?.lat
  );
  const lngRaw = pickFiniteNumber(
    sa.lng,
    sa.lon,
    sa.longitude,
    sa.location?.lng,
    sa.location?.lon,
    sa.location?.longitude,
    sa.geo?.lng,
    order?.geo?.to?.lng
  );

  const lat = pickGeoOrNull(latRaw);
  const lng = pickGeoOrNull(lngRaw);

  return {
    name,
    phone,
    address,
    city: municipalityName,
    district,
    province,
    wardNumber: ward,
    postalCode,
    locality,
    ...(lat != null ? { lat } : {}),
    ...(lng != null ? { lng } : {}),
    raw: sa || null,
  };
}

/* =========================================================
   Zone hints (aligned: always derived from NORMALIZED "to")
========================================================= */

function buildZoneHintsFromNormalized(to) {
  const t = to || {};
  return {
    wardNumber: safeStr(t.wardNumber) || "",
    postalCode: safeStr(t.postalCode) || "",
    locality: safeStr(t.locality) || "",
    city: safeStr(t.city) || "",
    district: safeStr(t.district) || "",
    province: safeStr(t.province) || "",
  };
}

function buildBookingReference(order, sellerIdStr) {
  const on = safeStr(order?.orderNumber);
  const oid = order?._id ? String(order._id) : "";
  const base = on || (oid ? `ORD-${oid.slice(-10)}` : `ORD-${Date.now()}`);
  return `${base}-${String(sellerIdStr).slice(-8)}`;
}

/* =========================================================
   Response tracking extraction (robust)
========================================================= */

function extractTrackingFromShippingResponse(respData) {
  const d = respData || {};
  const data = d?.data || d?.response || d;

  const trackingNumber = pickFirstNonEmpty(
    data?.trackingNumber,
    data?.carrier?.trackingNumber,
    data?.carrier?.tracking?.trackingNumber,
    data?.carrier?.tracking?.number,
    data?.awb,
    data?.awbNumber,
    data?.waybill,
    data?.waybillNumber,
    data?.shipment?.trackingNumber,
    data?.shipment?.carrierTrackingNumber,
    data?.shipment?.tracking?.trackingNumber,
    data?.shipment?.tracking?.number,
    data?.shipment?.tracking?.value,
    data?.shipment?.carrier?.trackingNumber,
    data?.shipment?.carrier?.tracking?.number,
    data?.shipment?.carrier?.tracking?.trackingNumber,
    data?.shipment?.awb,
    data?.referenceNumber,
    data?.refNo
  );

  const shipmentId = pickFirstNonEmpty(
    data?._id,
    data?.shipmentId,
    data?.shipment?._id,
    data?.shipment?.id,
    data?.carrier?.shipmentId,
    data?.carrier?.id,
    data?.id
  );

  const courier = pickFirstNonEmpty(
    data?.courier,
    data?.carrier?.name,
    data?.carrier?.carrierName,
    data?.carrier,
    data?.partner,
    data?.shipment?.carrier?.name,
    data?.shipment?.carrierName
  );

  return {
    trackingNumber: trackingNumber || "",
    shipmentId: shipmentId || "",
    courier: courier || "",
  };
}

/* =========================================================
   Booking attempt logging into Orders
========================================================= */

async function markQueued({ Orders, orderId, sellerIdStr }) {
  const path = buildSellerShippingPath(sellerIdStr);
  const t = now();

  await Orders.updateOne(
    { _id: orderId },
    {
      $set: {
        [`${path}.bookingState`]: "queued",
        [`${path}.lastBookingAttemptAt`]: t,
        [`${path}.updatedAt`]: t,
      },
    }
  );
}

async function appendAttempt({
  Orders,
  orderId,
  sellerIdStr,
  attempt,
  ok,
  httpStatus,
  code,
  message,
  durationMs,
  shipmentId,
  trackingNumber,
  courier,
}) {
  const path = buildSellerShippingPath(sellerIdStr);
  const t = now();

  const attemptDoc = {
    at: t,
    attempt: Number(attempt || 1),
    ok: Boolean(ok),
    status: Number.isFinite(Number(httpStatus)) ? Number(httpStatus) : null,
    code: truncateStr(code, 80),
    message: truncateStr(message, 400),
    durationMs: Number.isFinite(Number(durationMs)) ? Number(durationMs) : null,
    shipmentId: truncateStr(shipmentId, 80),
    trackingNumber: truncateStr(trackingNumber, 80),
    courier: truncateStr(courier, 80),
  };

  const update = {
    $push: { [`${path}.bookingAttempts`]: attemptDoc },
    $set: {
      [`${path}.lastBookingAttemptAt`]: t,
      [`${path}.updatedAt`]: t,
      [`${path}.bookingState`]: ok ? "booked" : "failed",
    },
    ...(ok ? {} : { $inc: { [`${path}.bookingRetryCount`]: 1 } }),
  };

  if (!ok) {
    update.$set[`${path}.lastBookingError`] = {
      at: t,
      status: attemptDoc.status,
      code: attemptDoc.code,
      message: attemptDoc.message,
    };
  } else {
    update.$set[`${path}.lastBookingError`] = null;
    if (trackingNumber) update.$set[`${path}.trackingNumber`] = trackingNumber;
    if (shipmentId) update.$set[`${path}.shipmentId`] = shipmentId;
    if (courier) update.$set[`${path}.courier`] = courier;
    update.$set[`${path}.bookedAt`] = t;
  }

  await Orders.updateOne({ _id: orderId }, update);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function backoffMs(attempt) {
  const a = Math.max(1, Number(attempt) || 1);
  return Math.min(5000, 500 + a * a * 300);
}

/* =========================================================
   Seller pickup address (Users collection) - Shop Profile preferred
========================================================= */

function envPickupFallback() {
  const latRaw = toFiniteNumberOrNull(process.env.SHIPPING_PICKUP_LAT);
  const lngRaw = toFiniteNumberOrNull(process.env.SHIPPING_PICKUP_LNG);

  const lat = pickGeoOrNull(latRaw);
  const lng = pickGeoOrNull(lngRaw);

  return {
    name: safeStr(process.env.SHIPPING_PICKUP_NAME || "Glamzi"),
    phone: normalizePhone(process.env.SHIPPING_PICKUP_PHONE || ""),
    address: safeStr(process.env.SHIPPING_PICKUP_ADDRESS || ""),
    city: safeStr(process.env.SHIPPING_PICKUP_CITY || "Kathmandu"),
    district: safeStr(process.env.SHIPPING_PICKUP_DISTRICT || ""),
    province: safeStr(process.env.SHIPPING_PICKUP_PROVINCE || ""),
    wardNumber: safeStr(process.env.SHIPPING_PICKUP_WARD || ""),
    postalCode: safeStr(process.env.SHIPPING_PICKUP_POSTAL_CODE || ""),
    locality: safeStr(process.env.SHIPPING_PICKUP_LOCALITY || ""),
    ...(lat != null ? { lat } : {}),
    ...(lng != null ? { lng } : {}),
  };
}

function buildPickupFromShopProfile(user) {
  const u = user || {};
  const sp = u.shopProfile || u.shop_profile || u.storeProfile || {};
  const loc = sp.location || sp.pickupLocation || sp.pickup || {};

  const name = pickFirstNonEmpty(
    sp.storeName,
    sp.shopName,
    sp.businessName,
    u.storeName,
    u.shopName,
    u.businessName,
    u.fullName,
    u.name,
    u.email
  );

  const phone = normalizePhone(
    pickFirstNonEmpty(
      sp.supportPhone,
      sp.phone,
      sp.mobile,
      u.shopPhone,
      u.storePhone,
      u.supportPhone,
      u.phone,
      u.mobile
    )
  );

  const address = pickFirstNonEmpty(
    loc.tole,
    loc.address,
    loc.addressLine1,
    sp.tole,
    sp.address,
    u.tole,
    u.address,
    u.addressLine1
  );

  const city = pickFirstNonEmpty(
    loc.municipalityName,
    loc.city,
    sp.municipalityName,
    sp.city,
    u.municipalityName,
    u.city,
    u.municipality
  );

  const district = pickFirstNonEmpty(loc.district, sp.district, u.district, u.districtName);
  const province = pickFirstNonEmpty(loc.province, sp.province, u.province, u.provinceName);

  const wardNumber =
    loc.wardNumber != null
      ? String(loc.wardNumber)
      : sp.wardNumber != null
      ? String(sp.wardNumber)
      : u.wardNumber != null
      ? String(u.wardNumber)
      : "";

  const postalCode = pickFirstNonEmpty(loc.postalCode, sp.postalCode, u.postalCode, u.zip, u.zipCode);

  const locality = pickFirstNonEmpty(loc.locality, loc.area, loc.tole, sp.locality, sp.area, sp.tole, u.locality, u.tole);

  // Geo: prefer shop profile location, but fall back to user.location (canonical pickup geo)
  const latRaw = pickFiniteNumber(
    loc.lat,
    loc.latitude,
    loc.geo?.lat,
    sp.geo?.lat,
    sp.lat,
    sp.latitude,
    u.location?.lat,
    u.location?.latitude,
    u.lat,
    u.latitude,
    u.geo?.lat,
    u.geo?.latitude
  );

  const lngRaw = pickFiniteNumber(
    loc.lng,
    loc.lon,
    loc.longitude,
    loc.geo?.lng,
    loc.geo?.lon,
    sp.geo?.lng,
    sp.geo?.lon,
    sp.lng,
    sp.lon,
    sp.longitude,
    u.location?.lng,
    u.location?.lon,
    u.location?.longitude,
    u.lng,
    u.lon,
    u.longitude,
    u.geo?.lng,
    u.geo?.lon,
    u.geo?.longitude
  );

  const lat = pickGeoOrNull(latRaw);
  const lng = pickGeoOrNull(lngRaw);

  return {
    name: name || "",
    phone: phone || "",
    address: address || "",
    city: city || "",
    district: district || "",
    province: province || "",
    wardNumber: wardNumber || "",
    postalCode: postalCode || "",
    locality: locality || "",
    ...(lat != null ? { lat } : {}),
    ...(lng != null ? { lng } : {}),
    raw: sp,
  };
}

function buildPickupFromSellerUser(user) {
  const u = user || {};
  const name = pickFirstNonEmpty(u.storeName, u.shopName, u.businessName, u.fullName, u.name, u.email);

  const phone = normalizePhone(pickFirstNonEmpty(u.phone, u.mobile, u.storePhone, u.shopPhone, u.supportPhone));

  const address = pickFirstNonEmpty(u.tole, u.address, u.addressLine1, u.street, u.location?.tole, u.location?.address);

  const city = pickFirstNonEmpty(
    u.municipalityName,
    u.municipality,
    u.city,
    u.location?.municipalityName,
    u.location?.city
  );

  const district = pickFirstNonEmpty(u.district, u.districtName, u.location?.district);
  const province = pickFirstNonEmpty(u.province, u.provinceName, u.location?.province);

  const wardNumber =
    u.wardNumber != null ? String(u.wardNumber) : u.location?.wardNumber != null ? String(u.location.wardNumber) : "";

  const postalCode = pickFirstNonEmpty(u.postalCode, u.zip, u.zipCode, u.location?.postalCode);

  const locality = pickFirstNonEmpty(u.locality, u.tole, u.location?.locality, u.location?.tole);

  const latRaw = pickFiniteNumber(u.location?.lat, u.location?.latitude, u.lat, u.latitude, u.geo?.lat, u.geo?.latitude);
  const lngRaw = pickFiniteNumber(
    u.location?.lng,
    u.location?.lon,
    u.location?.longitude,
    u.lng,
    u.lon,
    u.longitude,
    u.geo?.lng,
    u.geo?.lon,
    u.geo?.longitude
  );

  const lat = pickGeoOrNull(latRaw);
  const lng = pickGeoOrNull(lngRaw);

  return {
    name: name || "",
    phone: phone || "",
    address: address || "",
    city: city || "",
    district: district || "",
    province: province || "",
    wardNumber: wardNumber || "",
    postalCode: postalCode || "",
    locality: locality || "",
    ...(lat != null ? { lat } : {}),
    ...(lng != null ? { lng } : {}),
    raw: u,
  };
}

async function loadSellerPickupAddress({ Users, sellerIdStr }) {
  if (Users && sellerIdStr) {
    try {
      const { ObjectId } = await import("mongodb");
      const oid = ObjectId.isValid(String(sellerIdStr)) ? new ObjectId(String(sellerIdStr)) : null;
      const query = oid ? { $or: [{ _id: oid }, { sellerId: sellerIdStr }] } : { sellerId: sellerIdStr };

      const seller = await Users.findOne(query);
      if (seller) {
        // 1) Prefer shop profile (includes user.location geo fallback)
        const fromShop = buildPickupFromShopProfile(seller);
        if (fromShop.address || fromShop.city || fromShop.phone || (fromShop.lat != null && fromShop.lng != null)) {
          return { from: fromShop, source: "shopProfile" };
        }

        // 2) Fallback to user-level fields
        const fromUser = buildPickupFromSellerUser(seller);
        if (fromUser.address || fromUser.city || fromUser.phone || (fromUser.lat != null && fromUser.lng != null)) {
          return { from: fromUser, source: "users" };
        }
      }
    } catch (e) {
      console.warn("[shippingBridge] seller pickup lookup failed:", e?.message || e);
    }
  }

  const envFrom = envPickupFallback();
  if (envFrom.address || envFrom.city || envFrom.phone || (envFrom.lat != null && envFrom.lng != null)) {
    return { from: envFrom, source: "env" };
  }

  return {
    from: {
      name: "Glamzi",
      phone: "",
      address: "",
      city: "",
      district: "",
      province: "",
      wardNumber: "",
      postalCode: "",
      locality: "",
    },
    source: "default",
  };
}

/* =========================================================
   Legacy customer/items builder (optional but compatible)
========================================================= */

function buildLegacyCustomer(order) {
  const sa = order?.shippingAddress || {};
  const name = pickFirstNonEmpty(sa.fullName, sa.name, sa.contactName, order?.customerName, order?.customer?.name);
  const phone = normalizePhone(pickFirstNonEmpty(sa.phone, sa.mobile, order?.customerPhone, order?.customer?.phone));
  const address = pickFirstNonEmpty(sa.tole, sa.addressLine1, sa.address, sa.street);
  const city = pickFirstNonEmpty(sa.municipalityName, sa.city, sa.municipality);
  const district = pickFirstNonEmpty(sa.district, sa.districtName);
  const province = pickFirstNonEmpty(sa.province, sa.provinceName);
  const wardNumber = sa.wardNumber != null ? String(sa.wardNumber) : sa.ward != null ? String(sa.ward) : "";
  const postalCode = pickFirstNonEmpty(sa.postalCode, sa.zip, sa.zipCode);
  const locality = pickFirstNonEmpty(sa.locality, sa.area, sa.neighborhood, sa.tole);

  // include geo too (shipping service accepts customer.lat/lng as alternative)
  const latRaw = pickFiniteNumber(sa.lat, sa.latitude, sa.location?.lat, sa.location?.latitude, sa.geo?.lat);
  const lngRaw = pickFiniteNumber(
    sa.lng,
    sa.lon,
    sa.longitude,
    sa.location?.lng,
    sa.location?.lon,
    sa.location?.longitude,
    sa.geo?.lng
  );

  const lat = pickGeoOrNull(latRaw);
  const lng = pickGeoOrNull(lngRaw);

  return {
    name: safeStr(name),
    phone,
    address: safeStr(address),
    city: safeStr(city),
    district: safeStr(district),
    province: safeStr(province),
    wardNumber: safeStr(wardNumber),
    postalCode: safeStr(postalCode),
    locality: safeStr(locality),
    ...(lat != null ? { lat } : {}),
    ...(lng != null ? { lng } : {}),
  };
}

function buildLegacyItems(order, sellerIdStr) {
  const items = Array.isArray(order?.items) ? order.items : [];
  const sid = String(sellerIdStr || "");
  const sellerItems = items.filter((it) => String(it?.sellerId || "") === sid);

  return sellerItems.map((it) => ({
    productId: String(it?.productId || it?.product?._id || it?._id || ""),
    title: String(it?.title || it?.name || ""),
    quantity: Math.max(1, Math.floor(Number(it?.quantity) || 1)),
    unitPrice: safeNum(it?.price ?? it?.unitPrice ?? it?.salePrice ?? 0, 0),
    weightKg: safeNum(it?.weightKg ?? it?.weight ?? 0, 0) || 0,
  }));
}

function computeContentsFromItems(items) {
  const arr = Array.isArray(items) ? items : [];
  if (!arr.length) return "Items";
  const s = arr
    .slice(0, 20)
    .map((x) => `${String(x?.title || "Item")} x${Math.max(1, Math.floor(Number(x?.quantity) || 1))}`)
    .join(", ");
  return s.length > 200 ? s.slice(0, 200) : s;
}

function computeWeightFromItems(items) {
  const arr = Array.isArray(items) ? items : [];
  let w = 0;
  for (const it of arr) {
    const qty = safeNum(it?.quantity, 0);
    const per = safeNum(it?.weightKg, 0);
    if (qty > 0 && per > 0) w += qty * per;
  }
  return w > 0 ? w : 0.5;
}

/* =========================================================
   Payload builder (bridge + legacy)
========================================================= */

function normalizeContactAddress(address) {
  const addr = address || {};
  const latRaw = pickFiniteNumber(
    addr.lat,
    addr.latitude,
    addr.location?.lat,
    addr.location?.latitude,
    addr.geo?.lat,
    addr.geo?.latitude
  );
  const lngRaw = pickFiniteNumber(
    addr.lng,
    addr.lon,
    addr.longitude,
    addr.location?.lng,
    addr.location?.lon,
    addr.location?.longitude,
    addr.geo?.lng,
    addr.geo?.lon,
    addr.geo?.longitude
  );

  const lat = pickGeoOrNull(latRaw);
  const lng = pickGeoOrNull(lngRaw);

  return {
    name: safeStr(addr.name || addr.fullName || addr.contactName || "Glamzi"),
    phone: normalizePhone(addr.phone || addr.mobile || addr.contactPhone || addr.primaryPhone || ""),
    address: safeStr(addr.address || addr.addressLine1 || addr.street || addr.town || addr.locality || addr.tole || ""),
    city: safeStr(addr.city || addr.municipalityName || addr.municipality || addr.cityName || ""),
    district: safeStr(addr.district || addr.districtName || ""),
    province: safeStr(addr.province || addr.provinceName || ""),
    wardNumber: addr.wardNumber != null ? String(addr.wardNumber) : addr.ward != null ? String(addr.ward) : "",
    postalCode: safeStr(addr.postalCode || addr.zip || addr.zipCode || addr.postcode || ""),
    locality: safeStr(addr.locality || addr.area || addr.neighborhood || addr.tole || ""),
    ...(lat != null ? { lat } : {}),
    ...(lng != null ? { lng } : {}),
  };
}

function buildShippingPayloadFromOrder({ order, sellerIdStr, fromPickup, returnFlow = false }) {
  const reference = buildBookingReference(order, sellerIdStr);

  const cod =
    String(order?.paymentMethod || order?.payment?.method || "").toLowerCase() === "cod" || order?.isCod === true;
  const codAmount = cod ? computeSellerCodAmount(order, sellerIdStr) : 0;

  const toAddressRaw = buildAddressTo(order);
  const sellerPickupRaw = fromPickup || envPickupFallback();

  // for returnFlow (customer -> seller), swap pickup/dropoff
  const pickupRaw = returnFlow ? toAddressRaw : sellerPickupRaw;
  const dropoffRaw = returnFlow ? sellerPickupRaw : toAddressRaw;

  const from = normalizeContactAddress(pickupRaw);
  const to = normalizeContactAddress(dropoffRaw);

  const direction = returnFlow ? "return" : "delivery";
  const zoneHints = buildZoneHintsFromNormalized(to);

  // legacy optional (shipping service accepts both)
  const legacyCustomer = buildLegacyCustomer(order);
  const legacyItems = buildLegacyItems(order, sellerIdStr);
  const contents = computeContentsFromItems(legacyItems);
  const weightKg = computeWeightFromItems(legacyItems);
  const valueGuess = legacyItems.reduce((sum, it) => sum + safeNum(it.unitPrice, 0) * safeNum(it.quantity, 1), 0);

  const parcels = [
    {
      weight: safeNum(order?.parcels?.[0]?.weight ?? order?.weightKg ?? weightKg, weightKg),
      weightKg,
      contents,
      value: cod ? codAmount : valueGuess,
    },
  ];

  const payload = {
    partner: SHIPPING_PARTNER,
    orderId: order?._id ? String(order._id) : "",
    orderNumber: safeStr(order?.orderNumber) || null,
    sellerId: String(sellerIdStr),
    reference,
    cod,
    codAmount,

    // IMPORTANT: returnFlow marker (enables returnShipments write-path when true)
    ...(returnFlow ? { returnFlow: true } : {}),

    // bridge shape
    to: {
      name: to.name,
      phone: to.phone,
      address: to.address,
      city: to.city,
      district: to.district,
      province: to.province,
      wardNumber: to.wardNumber,
      postalCode: to.postalCode,
      locality: to.locality,
      ...(pickGeoOrNull(to?.lat) != null ? { lat: Number(to.lat) } : {}),
      ...(pickGeoOrNull(to?.lng) != null ? { lng: Number(to.lng) } : {}),
    },
    from: {
      name: from.name,
      phone: from.phone,
      address: from.address,
      city: from.city,
      district: from.district,
      province: from.province,
      wardNumber: from.wardNumber,
      postalCode: from.postalCode,
      locality: from.locality,
      ...(pickGeoOrNull(from?.lat) != null ? { lat: Number(from.lat) } : {}),
      ...(pickGeoOrNull(from?.lng) != null ? { lng: Number(from.lng) } : {}),
    },
    parcels,

    // legacy shape
    customer: legacyCustomer,
    items: legacyItems,

    meta: {
      orderNumber: safeStr(order?.orderNumber),
      mode: safeStr(order?.mode),
      zoneResolve: true,
      zoneHints,
      direction,
      isReturnFlow: Boolean(returnFlow),
    },
  };

  return payload;
}

/* =========================================================
   Factory used by ordersRoutes (forward delivery)
========================================================= */

export function createShippingHttpClient() {
  return axios.create({
    baseURL: SHIPPING_SERVICE_URL,
    timeout: Number.isFinite(SHIPPING_TIMEOUT_MS) ? SHIPPING_TIMEOUT_MS : 12000,
    headers: {
      "Content-Type": "application/json",
      ...(SHIPPING_INTERNAL_TOKEN ? { "x-internal-token": SHIPPING_INTERNAL_TOKEN } : {}),
    },
    // Keep axios from throwing on 4xx; we decide in isOkStatus/shouldRetryStatus
    validateStatus: (s) => s >= 200 && s < 500,
  });
}

export function bookShipmentFactory({ Orders, Users }) {
  if (!Orders) throw new Error("bookShipmentFactory requires { Orders } collection handle");

  const http = createShippingHttpClient();

  async function attemptBook({ orderId, sellerIdStr, reason, attempt }) {
    const t0 = Date.now();

    const order = await Orders.findOne({ _id: orderId });
    if (!order) {
      await appendAttempt({
        Orders,
        orderId,
        sellerIdStr,
        attempt,
        ok: false,
        httpStatus: 404,
        code: "ORDER_NOT_FOUND",
        message: "Order not found",
        durationMs: Date.now() - t0,
      });
      return { ok: false, retry: false };
    }

    const seg = order?.sellerFulfillment?.[sellerIdStr] || null;
    if (!seg) {
      await appendAttempt({
        Orders,
        orderId,
        sellerIdStr,
        attempt,
        ok: false,
        httpStatus: 400,
        code: "SELLER_SEGMENT_MISSING",
        message: "Order has no sellerFulfillment segment for sellerId",
        durationMs: Date.now() - t0,
      });
      return { ok: false, retry: false };
    }

    if (hasExistingTracking(seg)) {
      await appendAttempt({
        Orders,
        orderId,
        sellerIdStr,
        attempt,
        ok: true,
        httpStatus: 200,
        code: "ALREADY_BOOKED",
        message: "Tracking/shipmentId already present; skipping booking",
        durationMs: Date.now() - t0,
        shipmentId: safeStr(seg?.shipping?.shipmentId),
        trackingNumber: safeStr(seg?.shipping?.trackingNumber),
        courier: safeStr(seg?.shipping?.courier),
      });
      return { ok: true, retry: false };
    }

    const pickup = await loadSellerPickupAddress({ Users, sellerIdStr });

    const payload = buildShippingPayloadFromOrder({
      order,
      sellerIdStr,
      fromPickup: pickup?.from || null,
    });

    payload.meta = {
      ...(payload.meta || {}),
      reason: safeStr(reason) || "ready_to_ship",
      pickupSource: pickup?.source || "unknown",
    };

    try {
      const resp = await http.post("/api/shipments/book", payload);

      const status = Number(resp?.status || 0);
      const ok = isOkStatus(status);

      const { trackingNumber, shipmentId, courier } = extractTrackingFromShippingResponse(resp?.data);

      const path = buildSellerShippingPath(sellerIdStr);
      const t = now();

      // Always persist pickup + hints for debugging, even on failures
      const $set = {
        [`${path}.updatedAt`]: t,
        [`${path}.bookingState`]: ok ? "booked" : "failed",
        [`${path}.lastBookingError`]: ok
          ? null
          : {
              at: t,
              status,
              code: safeStr(resp?.data?.code) || `HTTP_${status}`,
              message: safeStr(resp?.data?.error) || safeStr(resp?.data?.message) || `Booking rejected (HTTP ${status})`,
            },

        // Persist pickup snapshot (audits/debug)
        [`${path}.pickup`]: {
          name: payload?.from?.name || "",
          phone: payload?.from?.phone || "",
          address: payload?.from?.address || "",
          city: payload?.from?.city || "",
          district: payload?.from?.district || "",
          province: payload?.from?.province || "",
          wardNumber: payload?.from?.wardNumber || "",
          postalCode: payload?.from?.postalCode || "",
          locality: payload?.from?.locality || "",
          ...(pickGeoOrNull(payload?.from?.lat) != null ? { lat: Number(payload.from.lat) } : {}),
          ...(pickGeoOrNull(payload?.from?.lng) != null ? { lng: Number(payload.from.lng) } : {}),
          source: pickup?.source || "unknown",
        },

        // Store last sent zone hints for debugging on the segment
        [`${path}.zoneHintsLastSent`]: payload?.meta?.zoneHints || null,
      };

      // Only set bookedAt / tracking fields on success
      if (ok) {
        $set[`${path}.bookedAt`] = t;
        if (trackingNumber) $set[`${path}.trackingNumber`] = trackingNumber;
        if (shipmentId) $set[`${path}.shipmentId`] = shipmentId;
        if (courier) $set[`${path}.courier`] = courier;
      }

      await Orders.updateOne({ _id: orderId }, { $set });

      await appendAttempt({
        Orders,
        orderId,
        sellerIdStr,
        attempt,
        ok,
        httpStatus: status || 200,
        code: ok ? "BOOKED" : safeStr(resp?.data?.code) || `HTTP_${status}`,
        message: ok ? "Shipment booking accepted" : safeStr(resp?.data?.message) || "Booking rejected",
        durationMs: Date.now() - t0,
        shipmentId: ok ? shipmentId : "",
        trackingNumber: ok ? trackingNumber : "",
        courier: ok ? courier : "",
      });

      if (ok) {
        if (!trackingNumber) {
          console.warn("[shippingBridge] booking succeeded but tracking missing", {
            orderId: String(orderId),
            sellerId: sellerIdStr,
            status,
            data: resp?.data || null,
          });
        }
        return { ok: true, retry: false };
      }

      return { ok: false, retry: shouldRetryStatus(status) };
    } catch (e) {
      const status = Number(e?.response?.status || 0) || 0;
      const code =
        safeStr(e?.response?.data?.code) ||
        safeStr(e?.code) ||
        (status >= 500 ? "REMOTE_5XX" : "REMOTE_ERROR");

      const msg =
        safeStr(e?.response?.data?.error) ||
        safeStr(e?.response?.data?.message) ||
        safeStr(e?.message) ||
        "Booking failed";

      await appendAttempt({
        Orders,
        orderId,
        sellerIdStr,
        attempt,
        ok: false,
        httpStatus: status || 500,
        code,
        message: msg,
        durationMs: Date.now() - t0,
      });

      return { ok: false, retry: shouldRetryStatus(status) };
    }
  }

  /**
   * Fire-and-forget API used by ordersRoutes
   */
  return function bookShipmentFireAndForget({ orderId, sellerId, reason = "ready_to_ship" }) {
    const orderIdStr = String(orderId || "").trim();
    const sellerIdStr = String(sellerId || "").trim();
    if (!orderIdStr || !sellerIdStr) return;

    (async () => {
      try {
        const { ObjectId } = await import("mongodb");
        const oid = ObjectId.isValid(orderIdStr) ? new ObjectId(orderIdStr) : null;
        if (!oid) return;

        await markQueued({ Orders, orderId: oid, sellerIdStr });

        for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
          const out = await attemptBook({ orderId: oid, sellerIdStr, reason, attempt });
          if (out.ok) return;
          if (!out.retry) return;

          if (attempt < MAX_ATTEMPTS) {
            await sleep(backoffMs(attempt));
          }
        }
      } catch (err) {
        console.error("[shippingBridge] unhandled error:", err?.message || err);
      }
    })();
  };
}

/* =========================================================
   Returns-only booking (NEW: Returns + ReturnShipments collections)
   - Does NOT write legacy order.returnRequest / order.returnAdmin.
   - Idempotent: if an active returnShipment exists, returns it unless force=true.
========================================================= */

function normalizeReturnStatusToken(v) {
  return safeStr(v).toLowerCase();
}

function rs(key) {
  return RETURN_STATUS?.[key] || RETURN_STATUS?.[String(key || "").toLowerCase()] || key;
}

function makeReturnEvent(actor, type, meta = {}) {
  const a = actor || {};
  return {
    at: now(),
    type: safeStr(type) || "EVENT",
    actor: {
      kind: safeStr(a.kind) || "system",
      id: safeStr(a.id) || "system",
      name: safeStr(a.name) || "",
    },
    meta: meta || {},
  };
}

/**
 * NEW signature (recommended):
 *   await bookReturnShipment({
 *     Returns, ReturnShipments, Orders, Users,
 *     returnId, sellerIdStr,
 *     actor: { kind:"admin", id:"..." }, note:"..."
 *   })
 *
 * Backward-compatible legacy signature:
 *   await bookReturnShipment({ Orders, Users, orderId, sellerIdStr, actorId, note })
 *   -> will STILL book returnFlow shipment, but will NOT update legacy fields.
 *      (It returns booking data only.) Prefer migrating callers to returnId.
 */
export async function bookReturnShipment({
  Returns,
  ReturnShipments,
  Orders,
  Users,

  returnId,
  sellerIdStr,
  actor = { kind: "system", id: "system" },
  note = "",
  force = false,

  // legacy inputs
  orderId,
  actorId,
}) {
  if (!Users) throw new Error("bookReturnShipment requires { Users }");
  if (!sellerIdStr) throw new Error("sellerIdStr is required");

  // ---------- LEGACY FALLBACK (no DB writes) ----------
  if (!returnId && orderId) {
    if (!Orders) throw new Error("bookReturnShipment legacy requires { Orders }");

    const order = await Orders.findOne({ _id: orderId });
    if (!order) throw new Error("Order not found");

    const pickup = await loadSellerPickupAddress({ Users, sellerIdStr });

    const payload = buildShippingPayloadFromOrder({
      order,
      sellerIdStr,
      fromPickup: pickup?.from || null,
      returnFlow: true,
    });

    payload.meta = {
      ...(payload.meta || {}),
      reason: "return_pickup",
      pickupSource: pickup?.source || "unknown",
      legacyCaller: true,
    };

    const http = createShippingHttpClient();
    const resp = await http.post("/api/shipments/book", payload);

    const status = Number(resp?.status || 0);
    if (!isOkStatus(status)) {
      const fallback = resp?.data?.error || resp?.data?.message || `HTTP ${status}`;
      throw new Error(fallback);
    }

    const { trackingNumber, courier, shipmentId } = extractTrackingFromShippingResponse(resp?.data);

    return {
      legacy: true,
      ok: true,
      courier: safeStr(courier) || null,
      trackingNumber: safeStr(trackingNumber) || null,
      shipmentId: safeStr(shipmentId) || null,
      partner: safeStr(resp?.data?.partner || resp?.data?.data?.partner || SHIPPING_PARTNER) || SHIPPING_PARTNER,
      scheduledAt: new Date(),
      note: note || undefined,
      actor: actorId || actor?.id || "system",
    };
  }

  // ---------- NEW RETURNS-ONLY FLOW ----------
  if (!Returns) throw new Error("bookReturnShipment requires { Returns }");
  if (!ReturnShipments) throw new Error("bookReturnShipment requires { ReturnShipments }");
  if (!Orders) throw new Error("bookReturnShipment requires { Orders }");
  if (!returnId) throw new Error("returnId is required");

  const { ObjectId } = await import("mongodb");
  const rid = ObjectId.isValid(String(returnId)) ? new ObjectId(String(returnId)) : null;
  if (!rid) throw new Error("Invalid returnId");

  const ret = await Returns.findOne({ _id: rid });
  if (!ret) throw new Error("Return not found");

  const cur = normalizeReturnStatusToken(ret?.status);
  const allowed =
    cur === normalizeReturnStatusToken(rs("approved_awaiting_pickup")) ||
    (force && cur === normalizeReturnStatusToken(rs("pickup_scheduled")));

  if (!allowed) {
    throw new Error(`Return status not eligible for pickup booking: ${ret?.status}`);
  }

  // Idempotent active booking
  const activeBookingId = ret?.pickup?.activeBookingId;
  if (activeBookingId && !force) {
    const existing = await ReturnShipments.findOne({ _id: activeBookingId, isActive: true });
    if (existing) {
      return {
        idempotent: true,
        booking: existing,
        trackingNumber: existing.trackingNumber || null,
        shipmentId: existing.externalShipmentId || null,
        courier: existing.courier || null,
      };
    }
  }

  // Load related order (for address snapshots)
  const orderObjId = ObjectId.isValid(String(ret?.orderId)) ? new ObjectId(String(ret.orderId)) : null;
  const order = orderObjId
    ? await Orders.findOne(
        { _id: orderObjId },
        {
          projection: {
            orderNumber: 1,
            userId: 1,
            customerName: 1,
            customerPhone: 1,
            shippingAddress: 1,
            shippingAddressSnapshot: 1,
          },
        }
      )
    : null;

  // Customer pickup address snapshot preference:
  const customerAddrRaw =
    ret?.request?.pickupAddressSnapshot ||
    ret?.customerAddressSnapshot ||
    order?.shippingAddress ||
    order?.shippingAddressSnapshot ||
    null;

  // Seller destination address snapshot preference:
  const pickup = await loadSellerPickupAddress({ Users, sellerIdStr });
  const sellerAddrRaw = ret?.sellerPickupAddressSnapshot || pickup?.from || null;

  const from = normalizeContactAddress({
    ...(customerAddrRaw || {}),
    name:
      customerAddrRaw?.name ||
      customerAddrRaw?.fullName ||
      ret?.customerName ||
      ret?.request?.customerName ||
      order?.customerName ||
      "Customer",
    phone:
      customerAddrRaw?.phone ||
      customerAddrRaw?.mobile ||
      ret?.customerPhone ||
      ret?.request?.customerPhone ||
      order?.customerPhone ||
      "",
    wardNumber: customerAddrRaw?.wardNumber ?? customerAddrRaw?.ward ?? "",
    address:
      customerAddrRaw?.address ||
      customerAddrRaw?.addressLine1 ||
      customerAddrRaw?.tole ||
      customerAddrRaw?.street ||
      "",
    city: customerAddrRaw?.city || customerAddrRaw?.municipalityName || customerAddrRaw?.municipality || "",
    postalCode: customerAddrRaw?.postalCode || customerAddrRaw?.zip || customerAddrRaw?.zipCode || "",
    district: customerAddrRaw?.district || customerAddrRaw?.districtName || "",
    province: customerAddrRaw?.province || customerAddrRaw?.provinceName || "",
    locality: customerAddrRaw?.locality || customerAddrRaw?.area || customerAddrRaw?.tole || "",
  });

  const to = normalizeContactAddress({
    ...(sellerAddrRaw || {}),
    name: sellerAddrRaw?.name || sellerAddrRaw?.storeName || "Seller",
    phone: sellerAddrRaw?.phone || "",
    wardNumber: sellerAddrRaw?.wardNumber ?? sellerAddrRaw?.ward ?? "",
    address: sellerAddrRaw?.address || sellerAddrRaw?.addressLine1 || sellerAddrRaw?.tole || "",
    city: sellerAddrRaw?.city || sellerAddrRaw?.municipalityName || sellerAddrRaw?.municipality || "",
    postalCode: sellerAddrRaw?.postalCode || sellerAddrRaw?.zip || sellerAddrRaw?.zipCode || "",
    district: sellerAddrRaw?.district || sellerAddrRaw?.districtName || "",
    province: sellerAddrRaw?.province || sellerAddrRaw?.provinceName || "",
    locality: sellerAddrRaw?.locality || sellerAddrRaw?.area || sellerAddrRaw?.tole || "",
  });

  // Parcels: derive from return items if available
  const items = Array.isArray(ret?.request?.items) ? ret.request.items : Array.isArray(ret?.items) ? ret.items : [];

  const contents = items.length
    ? items
        .slice(0, 20)
        .map((it) => {
          const qty = Math.max(
            1,
            Math.floor(Number(it?.qtyApproved ?? it?.qtyRequested ?? it?.qty ?? it?.quantity ?? 1) || 1)
          );
          return `${String(it?.title || it?.name || "Item")} x${qty}`;
        })
        .join(", ")
    : "Return items";

  const weightKg =
    items.reduce((sum, it) => {
      const qty = Math.max(
        1,
        Math.floor(Number(it?.qtyApproved ?? it?.qtyRequested ?? it?.qty ?? it?.quantity ?? 1) || 1)
      );
      const per = safeNum(it?.weightKg ?? it?.weight ?? 0, 0);
      return sum + (per > 0 ? per * qty : 0);
    }, 0) || 0.5;

  const parcels = [
    {
      weightKg,
      weight: weightKg,
      contents: contents.length > 200 ? contents.slice(0, 200) : contents,
      value: 0,
    },
  ];

  const attempt = Math.max(1, Math.floor(Number(ret?.pickup?.attempts || 0) + 1));
  const idempotencyKey = `return:${String(rid)}:partner:${SHIPPING_PARTNER}:attempt:${attempt}`;

  const zoneHints = buildZoneHintsFromNormalized(to);

  const payload = {
    partner: SHIPPING_PARTNER,
    orderId: ret?.orderId ? String(ret.orderId) : order?._id ? String(order._id) : "",
    orderNumber: safeStr(ret?.orderNumber) || safeStr(order?.orderNumber) || null,
    sellerId: String(sellerIdStr),

    // Return marker consumed by shipping service to enforce returnShipments write-path
    returnFlow: true,

    // Structured reference for return flows
    reference: {
      returnId: String(rid),
      returnNumber: safeStr(ret?.returnNumber) || null,
      orderId: ret?.orderId ? String(ret.orderId) : null,
      orderNumber: safeStr(ret?.orderNumber) || safeStr(order?.orderNumber) || null,
      sellerId: String(sellerIdStr),
      customerId: ret?.customerId ? String(ret.customerId) : order?.userId ? String(order.userId) : null,
      bookingAttempt: attempt,
      idempotencyKey,
    },

    from,
    to,
    parcels,

    meta: {
      reason: "return_pickup",
      zoneResolve: true,
      zoneHints,
      direction: "return",
      isReturnFlow: true,
      pickupSource: pickup?.source || "unknown",
      note: safeStr(note) || "",
    },
  };

  const http = createShippingHttpClient();
  const resp = await http.post("/api/shipments/book", payload);
  const status = Number(resp?.status || 0);

  if (!isOkStatus(status)) {
    const msg =
      safeStr(resp?.data?.error) ||
      safeStr(resp?.data?.message) ||
      `Return pickup booking rejected (HTTP ${status})`;
    throw new Error(msg);
  }

  const { trackingNumber, shipmentId, courier } = extractTrackingFromShippingResponse(resp?.data);
  const t = now();

  // Deactivate previous active booking (if force re-book)
  if (activeBookingId) {
    await ReturnShipments.updateOne(
      { _id: activeBookingId, isActive: true },
      { $set: { isActive: false, updatedAt: t } }
    );
  }

  const bookingDoc = {
    returnId: rid,
    orderId: payload.orderId || null,
    orderNumber: payload.orderNumber || null,
    sellerId: String(sellerIdStr),
    partner: SHIPPING_PARTNER,
    returnFlow: true,
    isActive: true,
    attempt,
    idempotencyKey,

    trackingNumber: safeStr(trackingNumber) || null,
    externalShipmentId: safeStr(shipmentId) || null,
    courier: safeStr(courier) || null,

    status: "pickup_scheduled",
    events: [
      {
        at: t,
        status: "pickup_scheduled",
        externalStatus: "PICKUP_SCHEDULED",
        source: "system",
        note: "Shipment booked",
        meta: {
          trackingNumber: safeStr(trackingNumber) || null,
          shipmentId: safeStr(shipmentId) || null,
          courier: safeStr(courier) || null,
          attempt,
          idempotencyKey,
          partner: SHIPPING_PARTNER,
        },
      },
    ],

    payloadSnapshot: payload,
    partnerResponseSnapshot: resp?.data || null,

    createdAt: t,
    updatedAt: t,
  };

  const ins = await ReturnShipments.insertOne(bookingDoc);

  const nextStatus = rs("pickup_scheduled");

  await Returns.updateOne(
    { _id: rid },
    {
      $set: {
        status: nextStatus,
        statusUpdatedAt: t,
        updatedAt: t,
        pickup: {
          ...(ret.pickup || {}),
          activeBookingId: ins.insertedId,
          partner: SHIPPING_PARTNER,
          latestTrackingNumber: safeStr(trackingNumber) || null,
          latestExternalShipmentId: safeStr(shipmentId) || null,
          courier: safeStr(courier) || null,
          bookedAt: t,
          attempts: attempt,
          lastBookingFailure: null,
          note: safeStr(note) || null,
        },
      },
      $push: {
        events: makeReturnEvent(
          { ...(actor || {}), id: safeStr(actor?.id) || safeStr(actorId) || "system" },
          "RETURN_PICKUP_BOOKED",
          {
            returnShipmentId: String(ins.insertedId),
            trackingNumber: safeStr(trackingNumber) || null,
            shipmentId: safeStr(shipmentId) || null,
            courier: safeStr(courier) || null,
            attempt,
            partner: SHIPPING_PARTNER,
          }
        ),
      },
      $inc: { version: 1 },
    }
  );

  const booking = await ReturnShipments.findOne({ _id: ins.insertedId });

  return {
    idempotent: false,
    booking,
    courier: safeStr(courier) || null,
    trackingNumber: safeStr(trackingNumber) || null,
    shipmentId: safeStr(shipmentId) || null,
    partner: SHIPPING_PARTNER,
    scheduledAt: t,
  };
}
