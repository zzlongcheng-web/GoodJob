import assert from "node:assert/strict";
import { validateAiWebsiteContacts } from "./website-contact-ai.js";

const pages = [{
  sourceUrl: "https://example-foreign.test/contact",
  text: [
    "Contact our export team",
    "Alex Morgan",
    "Export Sales Director",
    "alex.morgan@example-foreign.test",
    "Phone: +1 (415) 555-0198",
    "WhatsApp: +1 415 555 0198"
  ].join("\n")
}];

const accepted = validateAiWebsiteContacts({
  contacts: [{
    pageIndex: 1,
    name: "Alex Morgan",
    title: "Export Sales Director",
    emails: ["alex.morgan@example-foreign.test"],
    phones: ["+1 (415) 555-0198"],
    whatsapp: ["+1 415 555 0198"],
    evidenceQuote: "Alex Morgan"
  }]
}, pages);
assert.equal(accepted.length, 1);
assert.deepEqual(accepted[0]?.emails, ["alex.morgan@example-foreign.test"]);
assert.deepEqual(accepted[0]?.phones, ["+14155550198"]);
assert.equal(accepted[0]?.verificationStatus, "source_confirmed");
assert.deepEqual(accepted[0]?.reasonCodes, [
  "AI_STRUCTURED_PUBLIC_PAGE",
  "EXACT_SOURCE_TEXT_MATCH"
]);

const fabricated = validateAiWebsiteContacts({
  contacts: [{
    pageIndex: 1,
    name: "Alex Morgan",
    title: "Export Sales Director",
    emails: ["invented@example-foreign.test"],
    phones: ["+1 212 555 0111"],
    whatsapp: [],
    evidenceQuote: "Alex Morgan"
  }]
}, pages);
assert.equal(fabricated.length, 0, "AI 编造的联系方式必须被原文校验拒绝");

const mismatchedDomain = validateAiWebsiteContacts({
  contacts: [{
    pageIndex: 1,
    name: "Alex Morgan",
    emails: ["alex.morgan@example-foreign.test"],
    evidenceQuote: "Alex Morgan"
  }]
}, [{
  ...pages[0]!,
  text: pages[0]!.text.replace(
    "alex.morgan@example-foreign.test",
    "alex.morgan@example-foreign.test.au"
  )
}]);
assert.equal(mismatchedDomain.length, 0, "域名后缀更长时，不得把邮箱子串当作原文证据");

const mismatchedMailbox = validateAiWebsiteContacts({
  contacts: [{
    pageIndex: 1,
    name: "Alex Morgan",
    emails: ["alex.morgan@example-foreign.test"],
    evidenceQuote: "Alex Morgan"
  }]
}, [{
  ...pages[0]!,
  text: pages[0]!.text.replace(
    "alex.morgan@example-foreign.test",
    "team.alex.morgan@example-foreign.test"
  )
}]);
assert.equal(mismatchedMailbox.length, 0, "邮箱用户名更长时，不得把邮箱子串当作原文证据");

const caseInsensitiveEmail = validateAiWebsiteContacts({
  contacts: [{
    pageIndex: 1,
    name: "Alex Morgan",
    emails: ["ALEX.MORGAN@EXAMPLE-FOREIGN.TEST"]
  }]
}, pages);
assert.equal(caseInsensitiveEmail.length, 1, "完全一致的邮箱应允许大小写差异");

const paraphrasedEvidence = validateAiWebsiteContacts({
  contacts: [{
    pageIndex: 1,
    name: "Alex Morgan",
    title: "Export Sales Director",
    emails: ["alex.morgan@example-foreign.test"],
    phones: [],
    whatsapp: [],
    evidenceQuote: "Alex is the export director"
  }]
}, pages);
assert.equal(paraphrasedEvidence.length, 0, "AI 改写证据句时不得入库");

console.log("website contact AI validation tests passed");
