import type { ExecutiveReport } from "./modules/models";

// Excel 等表格工具可能把 CSV 文本字段当作公式执行，先阻断公式前缀。
function csvText(value: string): string {
  const safeValue = /^\s*[=+\-@]/u.test(value) ? "'" + value : value;
  return '"' + safeValue.replace(/"/g, '""') + '"';
}

export function buildRiskDealCsv(rows: ExecutiveReport["riskRows"]): string {
  const headers = ["客户", "商机名称", "负责人", "阶段", "金额", "币种", "风险原因", "下一步行动", "预计成交日期"];
  const lines = rows.map((row) => [
    csvText(row.customer),
    csvText(row.title),
    csvText(row.owner),
    csvText(row.stage),
    Number.isFinite(row.amount) ? String(row.amount) : "",
    csvText(row.currency),
    csvText(row.riskReasons.join("；")),
    csvText(row.nextAction),
    csvText(row.expectedCloseAt)
  ].join(","));

  // UTF-8 BOM 保证中文表头在常见 Excel 环境中能直接正确显示。
  return "\uFEFF" + [headers.map(csvText).join(","), ...lines].join("\r\n") + "\r\n";
}
