// utils/discountEngine.js
// Shared discount engine for admin + seller promos.
// - Seller: only ONE seller discount per item (product > category > store)
// - Admin: only ONE price discount at a time (coupon OR campaign), plus optional free_shipping
// - Admin + Seller can stack (unless explicitly disallowed)
// - Commission base later: (base - sellerDiscount); adminDiscount does NOT reduce seller earnings
//
// Backward compatible with older discount docs:
// - supports d.startAt/d.endAt and also d.startsAt/d.endsAt
// - supports d.isActive boolean and also d.status === "active"
// - supports disabling via d.disabledAt / d.disabledBy and also status === "disabled"
// - supports seller targeting via:
//   - d.productIds / d.categoryIds (legacy)
//   - d.targets.productIds / d.targets.categoryIds (newer unified schema)
//
// Production-grade hardening added:
// - ignore disabled discounts (disabledAt/status disabled)
// - coupon code normalization + safe eligibility checks
// - safer time window checks
// - deterministic priority picking (priority desc, updatedAt desc, createdAt desc)

const normalizeCode = (v) => String(v || "").trim().toUpperCase().replace(/\s+/g, "");

const n = (v, d = 0) => {
  const x = Number(v);
  return Number.isFinite(x) ? x : d;
};

const clamp = (v, min, max) => Math.max(min, Math.min(max, v));

function getStart(d) {
  return d?.startAt ?? d?.startsAt ?? null;
}
function getEnd(d) {
  return d?.endAt ?? d?.endsAt ?? null;
}

function asDateOrNull(v) {
  if (!v) return null;
  const dt = new Date(v);
  return Number.isNaN(dt.getTime()) ? null : dt;
}

const inWindow = (d, now) => {
  const s = asDateOrNull(getStart(d));
  const e = asDateOrNull(getEnd(d));
  const sOk = !s || s <= now;
  const eOk = !e || e >= now;
  return sOk && eOk;
};

const pct = (base, rate) => (base * rate) / 100;

function normalizeAuthority(d) {
  return String(d?.authority || "").trim().toLowerCase();
}

function normalizeScope(d) {
  return String(d?.scope || "").trim().toLowerCase();
}

function normalizeCodeType(d) {
  // Backward compatible:
  // - older: codeType "coupon"/"campaign"
  // - coupon if code exists (either top-level or nested), otherwise campaign
  const ct = String(d?.codeType || "").trim().toLowerCase();
  if (ct === "coupon" || ct === "campaign") return ct;

  const hasCouponCode = !!(d?.code || d?.coupon?.code);
  return hasCouponCode ? "coupon" : "campaign";
}

function normalizeDiscountKind(d) {
  // ✅ CANONICAL: percentage | flat | free_shipping
  const raw = String(d?.kind || d?.discountType || "").trim().toLowerCase();

  // map UI/legacy naming -> engine naming
  if (raw === "fixed") return "flat"; // ✅ critical compatibility fix
  if (raw === "percent") return "percentage";
  if (raw === "free-shipping") return "free_shipping";
  if (raw === "seller_discount") {
    const dt = String(d?.discountType || "").trim().toLowerCase();
    if (dt === "fixed") return "flat";
    if (dt === "percent") return "percentage";
    return dt;
  }

  return raw;
}

function getDiscountCode(d) {
  // Support both schemas:
  // - unified: d.code
  // - legacy: d.coupon.code
  const c = d?.code ?? d?.coupon?.code ?? "";
  return normalizeCode(c);
}

function getMinCartSubtotal(d) {
  // Support both schemas:
  // - unified: d.minCartSubtotal
  // - legacy: d.coupon.minCartValue
  if (d?.minCartSubtotal != null) return n(d.minCartSubtotal, 0);
  if (d?.coupon?.minCartValue != null) return n(d.coupon.minCartValue, 0);
  return 0;
}

function getMaxDiscount(d) {
  // Support both schemas:
  // - unified: d.maxDiscount
  // - (optional future) nested coupon.maxDiscount
  if (d?.maxDiscount != null) return n(d.maxDiscount, null);
  if (d?.coupon?.maxDiscount != null) return n(d.coupon.maxDiscount, null);
  return null;
}

function isActiveDiscount(d) {
  // Backward compatible:
  // - old: isActive: true
  // - new: status: "active"
  const byBool = d?.isActive === true;
  const byStatus = String(d?.status || "").toLowerCase() === "active";
  return byBool || byStatus;
}

function isDisabledDiscount(d) {
  // Disabled moderation flag or disabled-ish statuses
  if (d?.disabledAt) return true;
  const st = String(d?.status || "").toLowerCase();
  if (st === "disabled" || st === "inactive") return true;
  return false;
}

function productTargets(d) {
  const legacy = Array.isArray(d?.productIds) ? d.productIds : [];
  const newer = Array.isArray(d?.targets?.productIds) ? d.targets.productIds : [];
  return [...legacy, ...newer].map(String);
}

function categoryTargets(d) {
  const legacy = Array.isArray(d?.categoryIds) ? d.categoryIds : [];
  const newer = Array.isArray(d?.targets?.categoryIds) ? d.targets.categoryIds : [];
  return [...legacy, ...newer].map(String);
}

function adminTargetsCart(d, sets) {
  const scope = normalizeScope(d);
  const productIdSet = sets?.productIdSet || new Set();
  const categoryIdSet = sets?.categoryIdSet || new Set();

  // Flash discounts with explicit productIds should only apply to those products,
  // even if scope is missing or mis-set.
  const hasFlashTargets =
    String(d?.saleType || "").toLowerCase() === "flash" &&
    Array.isArray(d?.productIds) &&
    d.productIds.length > 0;
  const isFlash = String(d?.saleType || "").toLowerCase() === "flash";
  if (hasFlashTargets) {
    const targets = productTargets(d);
    return targets.some((pid) => productIdSet.has(String(pid)));
  }
  // Flash without targets should never apply
  if (isFlash) return false;

  if (scope === "product") {
    const targets = productTargets(d);
    return targets.some((pid) => productIdSet.has(String(pid)));
  }

  if (scope === "category") {
    const targets = categoryTargets(d);
    return targets.some((cid) => categoryIdSet.has(String(cid)));
  }

  // store/cart/shipping or unspecified -> treat as cart-wide eligible
  return true;
}

function adminAppliesToItem(item, discount) {
  const scope = normalizeScope(discount);
  const pid = item.productId ? String(item.productId) : "";
  const cid = item.categoryId ? String(item.categoryId) : "";

  const isFlash = String(discount?.saleType || "").toLowerCase() === "flash";
  const flashTargets =
    isFlash && Array.isArray(discount?.productIds) ? discount.productIds.map(String) : [];

  if (isFlash) {
    if (flashTargets.length === 0) return false;
    return flashTargets.includes(pid);
  }

  if (scope === "product") {
    return productTargets(discount).includes(pid);
  }

  if (scope === "category") {
    return categoryTargets(discount).includes(cid);
  }

  // store/cart/shipping or unspecified -> applies to all items
  return true;
}

function storeTargeted(d) {
  // store-wide discount can be:
  // - scope === "store"
  // - OR targets.store === true (future-proof)
  return normalizeScope(d) === "store" || d?.targets?.store === true;
}

function pickHighestPriority(list = []) {
  // Deterministic selection:
  // priority DESC, updatedAt DESC, createdAt DESC
  const arr = Array.isArray(list) ? list.slice() : [];
  arr.sort((a, b) => {
    const p = n(b?.priority, 0) - n(a?.priority, 0);
    if (p !== 0) return p;

    const ub = asDateOrNull(b?.updatedAt)?.getTime() || 0;
    const ua = asDateOrNull(a?.updatedAt)?.getTime() || 0;
    if (ub !== ua) return ub - ua;

    const cb = asDateOrNull(b?.createdAt)?.getTime() || 0;
    const ca = asDateOrNull(a?.createdAt)?.getTime() || 0;
    return cb - ca;
  });
  return arr[0] || null;
}

function discountAmount({ base, discount }) {
  if (!discount) return 0;

  const kind = normalizeDiscountKind(discount);
  const maxDiscount = getMaxDiscount(discount);

  if (kind === "percentage") {
    let amt = pct(base, n(discount.value, 0));
    if (maxDiscount != null) amt = Math.min(amt, n(maxDiscount, amt));
    return clamp(amt, 0, base);
  }

  if (kind === "flat") {
    const amt = n(discount.value, 0);
    const capped = maxDiscount != null ? Math.min(amt, n(maxDiscount, amt)) : amt;
    return clamp(capped, 0, base);
  }

  // free_shipping handled separately
  return 0;
}

function discountEligibleCartSubtotal(discount, subtotal) {
  const minCart = getMinCartSubtotal(discount);
  return !minCart || subtotal >= minCart;
}

function isSellerDiscount(d) {
  const auth = normalizeAuthority(d);
  if (auth) return auth === "seller";
  // Legacy: if no authority but sellerId present, treat as seller
  return !!d?.sellerId;
}

function isAdminDiscount(d) {
  return normalizeAuthority(d) === "admin";
}

/**
 * applyDiscounts(cart, context)
 * cart = { items: [{ productId, quantity, price, sellerId, categoryId? }], shippingFee }
 * context = { db, couponCode }
 */
export async function applyDiscounts(cart, context) {
  const { db, couponCode } = context || {};
  if (!db) throw new Error("applyDiscounts requires context.db");

  const Discounts = db.collection("discounts");
  const now = new Date();
  const code = normalizeCode(couponCode);

  const items = Array.isArray(cart?.items) ? cart.items : [];
  const shippingFee = Math.max(0, n(cart?.shippingFee, 0));

  // Normalize item math (and enforce canonical strings)
  const normalized = items.map((it) => {
    const quantity = Math.max(1, Math.floor(n(it.quantity, 1)));
    const price = Math.max(0, n(it.price, 0));
    const base = price * quantity;

    return {
      ...it,
      productId: it.productId != null ? String(it.productId) : null,
      sellerId: it.sellerId != null ? String(it.sellerId) : null,
      categoryId: it.categoryId != null ? String(it.categoryId) : null,
      quantity,
      price,
      _base: base,
    };
  });

  const subtotal = normalized.reduce((sum, it) => sum + it._base, 0);

  // IDs for fetching
  const sellerIds = [...new Set(normalized.map((i) => i.sellerId).filter(Boolean))];
  const productIds = [...new Set(normalized.map((i) => i.productId).filter(Boolean))];
  const categoryIds = [...new Set(normalized.map((i) => i.categoryId).filter(Boolean))];
  const productIdSet = new Set(productIds.map(String));
  const categoryIdSet = new Set(categoryIds.map(String));

  // Fetch candidate discounts (broad + backward compatible)
  const rawCandidates = await Discounts.find({
    $and: [
      { $or: [{ disabledAt: null }, { disabledAt: { $exists: false } }] },

      {
        $or: [
          { isActive: true },
          { status: "active" },
          { status: "ACTIVE" },
          { status: { $exists: false } },
        ],
      },

      {
        $or: [
          { startAt: { $exists: false } },
          { startAt: { $lte: now } },
          { startsAt: { $lte: now } },
        ],
      },
      {
        $or: [
          { endAt: { $exists: false } },
          { endAt: { $gte: now } },
          { endsAt: { $gte: now } },
        ],
      },

      {
        $or: [
          { authority: "admin" },
          { authority: "seller", sellerId: { $in: sellerIds } },
          { authority: { $exists: false }, sellerId: { $in: sellerIds } },
        ],
      },
    ],
  }).toArray();

  const active = rawCandidates.filter(
    (d) => isActiveDiscount(d) && !isDisabledDiscount(d) && inWindow(d, now)
  );

  // ---------------- ADMIN selection ----------------
  const adminAll = active.filter((d) => isAdminDiscount(d));
  const adminEligible = adminAll.filter((d) =>
    adminTargetsCart(d, { productIdSet, categoryIdSet })
  );

  // Coupon match (by code)
  const matchedCoupon =
    code &&
    pickHighestPriority(
      adminEligible.filter((d) => {
        const dCode = getDiscountCode(d);
        return dCode === code && normalizeCodeType(d) === "coupon";
      })
    );

  // If coupon is free_shipping, treat it as shipping discount (NOT price discount)
  const matchedCouponKind = matchedCoupon ? normalizeDiscountKind(matchedCoupon) : null;
  const adminCouponPrice = matchedCoupon && matchedCouponKind !== "free_shipping" ? matchedCoupon : null;
  const adminCouponShip = matchedCoupon && matchedCouponKind === "free_shipping" ? matchedCoupon : null;

  // Campaign only if no price coupon selected
  const adminCampaign = adminCouponPrice
    ? null
    : pickHighestPriority(
        adminEligible.filter((d) => {
          return normalizeCodeType(d) === "campaign" && !getDiscountCode(d);
        })
      );

  const adminPriceDiscount = adminCouponPrice || adminCampaign || null;

  // Optional free shipping (either via explicit shipping-scope promo OR via free_shipping coupon)
  const bestShippingPromo = pickHighestPriority(
    adminAll.filter((d) => {
      const sc = normalizeScope(d);
      const k = normalizeDiscountKind(d);
      return (
        (sc === "shipping" && k === "free_shipping") ||
        sc === "free_shipping" ||
        k === "free_shipping"
      );
    })
  );

  // Choose between: coupon free_shipping (if any) vs best shipping promo (priority wins deterministically)
  // If both exist, pickHighestPriority between them to keep deterministic behavior.
  const freeShippingCandidate = pickHighestPriority(
    [adminCouponShip, bestShippingPromo].filter(Boolean)
  );

  // Enforce minCartSubtotal for shipping discounts too
  const freeShippingEligible =
    !!freeShippingCandidate && discountEligibleCartSubtotal(freeShippingCandidate, subtotal);

  const freeShipping = freeShippingEligible ? freeShippingCandidate : null;

  const allowFreeShipStack =
    !!freeShipping &&
    (adminPriceDiscount ? !!adminPriceDiscount.stackableWithFreeShipping : true);

  const appliedFreeShipping =
    freeShipping && (allowFreeShipStack || !adminPriceDiscount) ? freeShipping : null;

  // ---------------- SELLER selection per item ----------------
  const sellerDiscountsBySeller = new Map();

  for (const sid of sellerIds) {
    const list = active
      .filter((d) => isSellerDiscount(d) && String(d.sellerId || "") === sid)
      .filter((d) => discountEligibleCartSubtotal(d, subtotal));

    sellerDiscountsBySeller.set(sid, list);
  }

  function bestSellerDiscountForItem(item) {
    const sid = item.sellerId;
    if (!sid) return null;

    const sellerAll = sellerDiscountsBySeller.get(sid) || [];

    const pid = item.productId ? String(item.productId) : null;
    const cid = item.categoryId ? String(item.categoryId) : null;

    const productD =
      pid &&
      pickHighestPriority(
        sellerAll.filter(
          (d) => normalizeScope(d) === "product" && productTargets(d).includes(pid)
        )
      );
    if (productD) return productD;

    const categoryD =
      cid &&
      pickHighestPriority(
        sellerAll.filter(
          (d) => normalizeScope(d) === "category" && categoryTargets(d).includes(cid)
        )
      );
    if (categoryD) return categoryD;

    const storeD = pickHighestPriority(sellerAll.filter((d) => storeTargeted(d)));
    return storeD || null;
  }

  // 1) Apply seller discounts first
  let sellerDiscountTotal = 0;

  const afterSeller = normalized.map((it) => {
    const base = it._base;

    const sellerD = bestSellerDiscountForItem(it);
    const sellerDisc = discountAmount({ base, discount: sellerD });

    sellerDiscountTotal += sellerDisc;

    const lineAfterSeller = base - sellerDisc;

    return {
      ...it,
      _sellerDiscount: sellerDisc,
      _afterSeller: lineAfterSeller,
      _appliedSeller: sellerD
        ? {
            discountId: String(sellerD._id),
            authority: "seller",
            funding: "seller",
            scope: sellerD.scope || "store",
            kind: sellerD.kind || sellerD.discountType || null,
            discountTypeNormalized: normalizeDiscountKind(sellerD) || null,
            value: n(sellerD.value, 0),
            sellerId: String(sellerD.sellerId || it.sellerId || ""),
          }
        : null,
    };
  });

  // 2) Apply admin discounts on top (price discounts only)
  let adminDiscountTotal = 0;

  const adminKind = adminPriceDiscount ? normalizeDiscountKind(adminPriceDiscount) : null;
  let perLineAdmin = afterSeller.map(() => 0);

  if (adminPriceDiscount) {
    const eligible = discountEligibleCartSubtotal(adminPriceDiscount, subtotal);
    const itemEligibility = afterSeller.map((it) =>
      eligible ? adminAppliesToItem(it, adminPriceDiscount) : false
    );

    if (eligible) {
      if (adminKind === "percentage") {
        perLineAdmin = afterSeller.map((it) =>
          adminAppliesToItem(it, adminPriceDiscount)
            ? discountAmount({ base: it._afterSeller, discount: adminPriceDiscount })
            : 0
        );
      } else if (adminKind === "flat") {
        const flat = n(adminPriceDiscount.value, 0);
        const basePool = afterSeller.reduce(
          (sum, it, idx) => sum + (itemEligibility[idx] ? it._afterSeller : 0),
          0
        );

        if (basePool > 0 && flat > 0) {
          const maxDiscount = getMaxDiscount(adminPriceDiscount);
          const cappedFlat = maxDiscount != null ? Math.min(flat, n(maxDiscount, flat)) : flat;

          let remaining = clamp(cappedFlat, 0, basePool);

          perLineAdmin = afterSeller.map((it, idx) => {
            if (idx === afterSeller.length - 1) {
              const last = itemEligibility[idx] ? clamp(remaining, 0, it._afterSeller) : 0;
              remaining -= last;
              return last;
            }

            if (!itemEligibility[idx]) return 0;

            const share = (it._afterSeller / basePool) * remaining;
            const amt = clamp(share, 0, it._afterSeller);
            remaining -= amt;
            return amt;
          });
        }
      }
    }
  }

  const pricedItems = afterSeller.map((it, idx) => {
    const base = it._base;
    const sellerDisc = it._sellerDiscount;

    const adminDisc = clamp(n(perLineAdmin[idx], 0), 0, it._afterSeller);
    adminDiscountTotal += adminDisc;

    const final = it._afterSeller - adminDisc;

    return {
      ...it,
      pricing: {
        base,
        sellerDiscount: sellerDisc,
        adminDiscount: adminDisc,
        final,
      },
      applied: {
        seller: it._appliedSeller,
        admin: adminPriceDiscount
          ? {
              discountId: String(adminPriceDiscount._id),
              authority: "admin",
              funding: "admin",
              code: getDiscountCode(adminPriceDiscount) || null,
              codeType: normalizeCodeType(adminPriceDiscount),
              kind: adminPriceDiscount.kind || adminPriceDiscount.discountType || null,
              discountTypeNormalized: adminKind || null,
              value: n(adminPriceDiscount.value, 0),
            }
          : null,
      },
    };
  });

  const discountedSubtotal = pricedItems.reduce((sum, it) => sum + n(it.pricing?.final, 0), 0);

  // Shipping
  const shippingDiscount = appliedFreeShipping ? shippingFee : 0;
  const shippingDue = Math.max(0, shippingFee - shippingDiscount);

  const grandTotal = Math.max(0, discountedSubtotal + shippingDue);

  return {
    items: pricedItems,
    totals: {
      subtotal,
      discountedSubtotal,
      sellerDiscountTotal,
      adminDiscountTotal,
      shippingFee,
      shippingDiscount,
      grandTotal,
    },
    appliedAdmin: {
      priceDiscount: adminPriceDiscount
        ? {
            discountId: String(adminPriceDiscount._id),
            authority: "admin",
            funding: "admin",
            code: getDiscountCode(adminPriceDiscount) || null,
            codeType: normalizeCodeType(adminPriceDiscount),
          }
        : null,
      freeShipping: appliedFreeShipping
        ? {
            discountId: String(appliedFreeShipping._id),
            authority: "admin",
            funding: "admin",
            kind: "free_shipping",
            code: getDiscountCode(appliedFreeShipping) || null, // ✅ helpful if it came from coupon
            codeType: normalizeCodeType(appliedFreeShipping),
          }
        : null,
    },
    meta: {
      couponCode: code || null,
      sellerIds,
      productIds,
      categoryIds,
      evaluatedAt: now.toISOString(),
    },
  };
}
