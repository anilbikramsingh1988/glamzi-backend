import assert from "node:assert/strict";
import { claimJob } from "../workers/emailWorker.js";

const fakeJob = { _id: "1", status: "queued" };
let called = false;

const fakeDb = {
  collection() {
    return {
      async findOneAndUpdate() {
        called = true;
        return { value: fakeJob };
      },
    };
  },
};

const res = await claimJob(fakeDb, "lock-1");
assert.equal(called, true);
assert.equal(res._id, "1");

console.log("worker lock tests passed");
