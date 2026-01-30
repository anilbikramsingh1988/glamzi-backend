import { DateTime } from "luxon";

const TZ = "Asia/Kathmandu";

const defaultFromKeyByType = (type) => {
  if (!type) return "no-reply";
  if (type.startsWith("order.")) return "orders";
  if (type.startsWith("return.")) return "returns";
  if (type.startsWith("settlement.")) return "settlements";
  if (type.startsWith("support.")) return "support";
  if (type.startsWith("alert.")) return "alerts";
  if (type.startsWith("marketing.")) return "info";
  return "no-reply";
};

export function resolveRouting(job, settings) {
  const type = String(job.type || "");
  const fromKey = job.fromKey || defaultFromKeyByType(type);
  const fromProfile = settings.fromProfiles?.[fromKey] || null;

  const from = fromProfile
    ? { email: fromProfile.fromEmail, name: fromProfile.fromName }
    : { email: settings.fromProfiles?.["no-reply"]?.fromEmail || "no-reply@glamzibeauty.com", name: "Glamzi" };

  const replyToEmail = fromProfile?.replyToEmail || null;
  const replyToName = fromProfile?.replyToName || null;
  const replyTo = replyToEmail ? { email: replyToEmail, name: replyToName || undefined } : null;

  const templateDisabled = settings.disabledTemplates?.includes(job.templateId) || false;
  const categoryAllowed = settings.allowedTemplatesByCategory
    ? settings.allowedTemplatesByCategory[settings.templateCategory || job.templateCategory || "transactional"] !== false
    : true;

  return { fromKey, from, replyTo, templateDisabled, categoryAllowed };
}

export function isQuietHoursNow(settings) {
  const quiet = settings.quietHours || {};
  if (!quiet.enabled) return false;

  const now = DateTime.now().setZone(TZ);
  const start = Number(quiet.startHour || 22);
  const end = Number(quiet.endHour || 8);

  if (start === end) return false;
  if (start < end) {
    return now.hour >= start && now.hour < end;
  }
  return now.hour >= start || now.hour < end;
}

export function shouldRespectQuietHours(type) {
  if (!type) return false;
  return type.startsWith("marketing.") || type.startsWith("newsletter.");
}

export function getNextQuietHoursEnd(settings) {
  const quiet = settings.quietHours || {};
  const end = Number(quiet.endHour || 8);
  const now = DateTime.now().setZone(TZ);
  let target = now.set({ hour: end, minute: 0, second: 0, millisecond: 0 });
  if (target <= now) {
    target = target.plus({ days: 1 });
  }
  return target.toJSDate();
}

export function isSuppressed(settings, emails = []) {
  const suppressedDomains = new Set((settings.suppression?.blockedDomains || []).map((d) => d.toLowerCase()));
  const suppressedEmails = new Set((settings.suppression?.blockedEmails || []).map((d) => d.toLowerCase()));

  for (const email of emails) {
    const addr = String(email || "").toLowerCase();
    if (!addr) continue;
    if (suppressedEmails.has(addr)) return true;
    const parts = addr.split("@");
    if (parts[1] && suppressedDomains.has(parts[1])) return true;
  }
  return false;
}
