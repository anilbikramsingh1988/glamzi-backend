export async function nextSequence({ Counters, key, session }) {
  const res = await Counters.findOneAndUpdate(
    { _id: key },
    { $inc: { seq: 1 } },
    { upsert: true, returnDocument: "after", session }
  );
  return Number(res?.value?.seq ?? res?.seq ?? 1);
}

export function formatReturnNumber(seq) {
  const year = new Date().getFullYear();
  return `RET-${year}-${String(seq).padStart(6, "0")}`;
}

export function formatRefundNumber(seq) {
  const year = new Date().getFullYear();
  return `RFD-${year}-${String(seq).padStart(6, "0")}`;
}
