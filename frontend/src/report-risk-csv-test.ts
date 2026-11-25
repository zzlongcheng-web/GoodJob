import { strict as assert } from "node:assert";
import { buildRiskDealCsv } from "./report-risk-csv";
import type { ExecutiveReport } from "./modules/models";

const rows: ExecutiveReport["riskRows"] = [{
  id: "d1",
  customerId: "c1",
  title: '=HYPERLINK("https://example.com","测试")',
  customer: '客户 "A",有限公司',
  owner: " 张三",
  stage: "报价中",
  amount: -1250.5,
  currency: "USD",
  riskReasons: ["付款延期", "客户\n未回复"],
  nextAction: "  =1+1",
  expectedCloseAt: "2026-11-30"
}];

const csv = buildRiskDealCsv(rows);
assert.ok(csv.startsWith("\uFEFF"), "Excel 中文兼容 BOM");
assert.ok(csv.includes('"客户","商机名称","负责人","阶段","金额","币种","风险原因","下一步行动","预计成交日期"\r\n'));
assert.ok(csv.includes('"客户 ""A"",有限公司"'), "双引号和逗号按 CSV 标准转义");
assert.ok(csv.includes('"\'=HYPERLINK(""https://example.com"",""测试"")"'), "商机标题公式注入保护");
assert.ok(csv.includes(',"报价中",-1250.5,"USD",'), "负金额保留为数字");
assert.ok(csv.includes('"付款延期；客户\n未回复"'), "多行内容安全保留在单元格中");
assert.ok(csv.includes('"\'  =1+1"'), "前导空格公式注入保护");
assert.ok(csv.endsWith("\r\n"));
assert.equal(buildRiskDealCsv([]), '\uFEFF"客户","商机名称","负责人","阶段","金额","币种","风险原因","下一步行动","预计成交日期"\r\n');
assert.equal(rows[0].title[0], "=", "原始数据不被修改");
console.log("风险商机 CSV 导出测试通过");
