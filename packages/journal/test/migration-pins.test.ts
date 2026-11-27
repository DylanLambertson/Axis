// Copyright (c) 2026 Dylan Lambertson. All rights reserved.
import assert from "node:assert/strict";
import { test } from "node:test";

// Every shipped journal migration is pinned by the SHA-256 of its SQL: a migration is never edited, a new one is added
// (moved here unchanged from journal.test.ts, which had reached its length budget).

test("the shipped journal migration is pinned by hash (add a new migration instead of editing it)", async () => {
  const { createHash } = await import("node:crypto");
  const { JOURNAL_MIGRATIONS } = await import("../src/index.js");
  assert.equal(JOURNAL_MIGRATIONS.length, 21);
  assert.equal(createHash("sha256").update(JOURNAL_MIGRATIONS[0]?.sql ?? "").digest("hex"), "92332f71a375b32c59a45d0059e20ffd5a90090032b72c567ac0698c5db4d2e9");
  assert.equal(createHash("sha256").update(JOURNAL_MIGRATIONS[1]?.sql ?? "").digest("hex"), "9302852a810e1b6069f421ebb3af4b5493bbeb28753da79d24ed832e2571d0bf");
  assert.equal(createHash("sha256").update(JOURNAL_MIGRATIONS[2]?.sql ?? "").digest("hex"), "d5e282807fca70f2c7d4d627af46c38106a0395e67107f20a0c07012adf0d139");
  assert.equal(createHash("sha256").update(JOURNAL_MIGRATIONS[3]?.sql ?? "").digest("hex"), "689b6d14fcc586797d3cdda5153c583a068f8576f1e297f06cea66c841291041");
  assert.equal(createHash("sha256").update(JOURNAL_MIGRATIONS[4]?.sql ?? "").digest("hex"), "3a6a18850c346119ddb1273893dd486b6cd1a5af07d711584f1cda6561a60346");
  assert.equal(createHash("sha256").update(JOURNAL_MIGRATIONS[5]?.sql ?? "").digest("hex"), "24d3eee858381b0e0413a1a6fb41432a836f74b901078b0121a66c1de7162ced");
  assert.equal(createHash("sha256").update(JOURNAL_MIGRATIONS[6]?.sql ?? "").digest("hex"), "35fab33677d380217cbee61400268b7231c69b001369a176bfd4e5edd5c880a8");
  assert.equal(createHash("sha256").update(JOURNAL_MIGRATIONS[7]?.sql ?? "").digest("hex"), "e9777ff851d6c25454c52b9017a665ae8084ccec9131293b094eda8e47c8efa2");
  assert.equal(createHash("sha256").update(JOURNAL_MIGRATIONS[8]?.sql ?? "").digest("hex"), "655118d2b1b77dff7d5add863f99e7a25798a469ee136a055dae2d36a75c415d");
  assert.equal(createHash("sha256").update(JOURNAL_MIGRATIONS[9]?.sql ?? "").digest("hex"), "1d4b6588bf49e0dd13213e05186f75703ca8db6d0956bed1909fa4bb0e4be5f2");
  assert.equal(createHash("sha256").update(JOURNAL_MIGRATIONS[10]?.sql ?? "").digest("hex"), "3b843e6175ef7f752ce986898f38608f19b103085b6964fd92d9c9fec68288bc");
  assert.equal(createHash("sha256").update(JOURNAL_MIGRATIONS[11]?.sql ?? "").digest("hex"), "3e4fa0c6d526267c402b016a24d4bd0388f25f6a73e202c0126e68259ea686c0");
  assert.equal(createHash("sha256").update(JOURNAL_MIGRATIONS[12]?.sql ?? "").digest("hex"), "3603500fdaf78313b487ed3251b700285f054d6560482e7b1c308c09dfeb7208");
  assert.equal(createHash("sha256").update(JOURNAL_MIGRATIONS[13]?.sql ?? "").digest("hex"), "9e68b1f03d97be506ec7be4fff4ecba79aae206fa5ae7fc66d7b5d579326ad26");
  assert.equal(createHash("sha256").update(JOURNAL_MIGRATIONS[14]?.sql ?? "").digest("hex"), "cc9fa1464a03d3002d4b556c92003fd8f4d707754a23447599d58627839999b1");
  assert.equal(createHash("sha256").update(JOURNAL_MIGRATIONS[15]?.sql ?? "").digest("hex"), "2c3c5659a4e5d62c738cba7e38ad5de9252f89ba807f49c744ddfdafe35bbc7d");
  assert.equal(createHash("sha256").update(JOURNAL_MIGRATIONS[16]?.sql ?? "").digest("hex"), "402a861efd7308b2288b276f42fd14f61e045d9ae9b20747ac01e673c87c8dc9");
  assert.equal(createHash("sha256").update(JOURNAL_MIGRATIONS[17]?.sql ?? "").digest("hex"), "d1c712fd13537e242e0b6cb7bb04c9f8471d90da8091612f497fef5b9524099c");
  assert.equal(createHash("sha256").update(JOURNAL_MIGRATIONS[18]?.sql ?? "").digest("hex"), "6d54210294c99a1b7d5dc167162b1f65f9e411d5147f7b0b6cd07b0bbbb95a16");
  assert.equal(createHash("sha256").update(JOURNAL_MIGRATIONS[19]?.sql ?? "").digest("hex"), "5e16e1c14187b473483a60fa6762b741bdcc01f06ddd6492474cdc94b7ec7b1d");
  assert.equal(createHash("sha256").update(JOURNAL_MIGRATIONS[20]?.sql ?? "").digest("hex"), "5af27a9e57fe8f03964e7e7cd5fb7e101f7d098206a36710367ee4f4e4ab85bc");
});
