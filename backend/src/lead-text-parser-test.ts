import assert from "node:assert/strict";
import { parseLeadText } from "./lead-text-parser.js";

const a = parseLeadText(`Company: Green Valley Feeds Ltd
Contact: John Okafor
Tel: +234 803 123 4567
WhatsApp: +234 803 123 4567
Email: john@greenvalleyfeeds.com
Website: www.greenvalleyfeeds.com
Looking for pellet mill, 1-2 ton/hour. Dealer in Lagos.`);
assert.equal(a.company, "Green Valley Feeds Ltd");
assert.equal(a.contact, "John Okafor");
assert.equal(a.whatsapp, "+2348031234567");
assert.equal(a.email, "john@greenvalleyfeeds.com");
assert.equal(a.country, "尼日利亚");
assert.ok(a.confidence >= 80);

const b = parseLeadText(`Hello, I am interested in your chaff cutter.
Best regards,
Ahmed Khan
Khan Agro Machinery Trading
+92 300 1234567 (WhatsApp)
ahmed@khanagro.pk`);
assert.equal(b.contact, "Ahmed Khan");
assert.equal(b.company, "Khan Agro Machinery Trading");
assert.equal(b.phone, "+923001234567");
assert.equal(b.whatsapp, "+923001234567");
assert.equal(b.country, "巴基斯坦");

const c = parseLeadText("公司：肯尼亚农业设备有限公司\n联系人：王芳\n微信：wangfang_88\n电话：+254 712 345 678\n国家：肯尼亚");
assert.equal(c.company, "肯尼亚农业设备有限公司");
assert.equal(c.contact, "王芳");
assert.equal(c.wechat, "wangfang_88");
assert.equal(c.country, "肯尼亚");

const d = parseLeadText("hello");
assert.equal(d.company, "");
assert.ok(d.missing.includes("公司名称") && d.missing.includes("联系方式"));
assert.equal(d.confidence, 0);

const e = parseLeadText("someone@gmail.com wants prices");
assert.equal(e.email, "someone@gmail.com");
assert.equal(e.company, "");

const f = parseLeadText("wa.me/8801712345678 Dhaka Feed House");
assert.equal(f.whatsapp, "+8801712345678");
assert.equal(f.country, "孟加拉国");
console.log("lead-text-parser-test ok");

// ---------- 批量 ----------
import { splitLeadBlocks, parseLeadBatch, MAX_BATCH_LEADS } from "./lead-text-parser.js";

// 编号格式
const numbered = splitLeadBlocks(`1. Green Feeds Ltd, John, +234 803 111 2222, john@greenfeeds.com
2. Khan Agro Trading, Ahmed, +92 300 111 2222, ahmed@khanagro.pk
3. Wang Farm Machinery Co., Wang, +254 712 111 222`);
assert.equal(numbered.length, 3);
assert.ok(numbered[0].startsWith("Green Feeds Ltd"));
const n0 = parseLeadText(numbered[0]);
assert.equal(n0.company, "Green Feeds Ltd");
assert.equal(n0.contact, "John");
assert.equal(n0.country, "尼日利亚");

// 空行分隔 + 标签
const labelled = `Company: Alpha Feeds Ltd
Contact: Alice
Email: alice@alphafeeds.com

Company: Beta Agro Trading
Contact: Bob
WhatsApp: +233 20 111 2222`;
const lb = parseLeadBatch(labelled);
assert.equal(lb.length, 2);
assert.equal(lb[0].draft.company, "Alpha Feeds Ltd");
assert.equal(lb[1].draft.whatsapp, "+233201112222");
assert.equal(lb[1].draft.country, "加纳");

// 只有标签、没有空行
const noBlank = parseLeadBatch("公司：甲饲料有限公司\n联系人：甲\n邮箱：a@jia.com\n公司：乙农机有限公司\n联系人：乙\n电话：+254 700 111 222");
assert.equal(noBlank.length, 2);
assert.equal(noBlank[1].draft.company, "乙农机有限公司");

// 每行一家
const perLine = splitLeadBlocks("Farm One +234 803 000 0001\nFarm Two +234 803 000 0002\nFarm Three +234 803 000 0003");
assert.equal(perLine.length, 3);

// 单家不乱拆
assert.equal(splitLeadBlocks("Company: Solo Ltd\nEmail: solo@solo.com").length, 1);

// 50 家规模
const big = Array.from({ length: 50 }, (_, i) => `${i + 1}. Dealer ${i + 1} Trading Ltd, +234 803 ${String(1000 + i).padStart(4, "0")} ${String(i).padStart(3, "0")}, d${i + 1}@dealer${i + 1}.com`).join("\n");
const bigBatch = parseLeadBatch(big);
assert.equal(bigBatch.length, 50);
assert.ok(bigBatch.every((item, i) => item.draft.company === `Dealer ${i + 1} Trading Ltd` && item.draft.email));
assert.equal(MAX_BATCH_LEADS, 50);
console.log("lead batch parser test ok");
