/**
 * 把业务员粘贴的一段客户信息（名片、聊天、询盘邮件、阿里国际站截图转文字等）识别成线索字段。
 * 纯规则识别，不调用外部服务，不会把客户资料发给第三方。识别结果只是"草稿"，业务员确认后才入库。
 */
export interface ParsedLeadText {
  company: string;
  contact: string;
  email: string;
  phone: string;
  whatsapp: string;
  wechat: string;
  country: string;
  website: string;
  /** 0-100：关键字段（公司/联系方式）识别到越多越高 */
  confidence: number;
  /** 没识别到、需要业务员补充的字段 */
  missing: string[];
}

const FREE_MAIL = new Set(["gmail.com", "yahoo.com", "hotmail.com", "outlook.com", "qq.com", "163.com", "126.com", "icloud.com", "live.com", "msn.com", "aol.com", "proton.me", "protonmail.com", "yandex.ru", "mail.ru"]);

// 区号 -> 国家（仅覆盖饲料/农机常见市场；识别不到就留空，不乱猜）
const DIAL_PREFIX: Array<[string, string]> = [
  ["+234", "尼日利亚"], ["+233", "加纳"], ["+254", "肯尼亚"], ["+255", "坦桑尼亚"], ["+256", "乌干达"], ["+251", "埃塞俄比亚"],
  ["+260", "赞比亚"], ["+263", "津巴布韦"], ["+27", "南非"], ["+20", "埃及"], ["+212", "摩洛哥"], ["+213", "阿尔及利亚"],
  ["+92", "巴基斯坦"], ["+91", "印度"], ["+880", "孟加拉国"], ["+94", "斯里兰卡"], ["+977", "尼泊尔"],
  ["+62", "印度尼西亚"], ["+63", "菲律宾"], ["+84", "越南"], ["+66", "泰国"], ["+60", "马来西亚"],
  ["+998", "乌兹别克斯坦"], ["+7", "俄罗斯/哈萨克斯坦"], ["+90", "土耳其"], ["+98", "伊朗"], ["+964", "伊拉克"], ["+966", "沙特阿拉伯"], ["+971", "阿联酋"],
  ["+52", "墨西哥"], ["+51", "秘鲁"], ["+57", "哥伦比亚"], ["+55", "巴西"], ["+54", "阿根廷"], ["+56", "智利"], ["+593", "厄瓜多尔"],
  ["+49", "德国"], ["+33", "法国"], ["+34", "西班牙"], ["+39", "意大利"], ["+48", "波兰"], ["+380", "乌克兰"], ["+40", "罗马尼亚"]
];

const COUNTRY_WORDS: Array<[RegExp, string]> = [
  [/nigeria|尼日利亚/i, "尼日利亚"], [/ghana|加纳/i, "加纳"], [/kenya|肯尼亚/i, "肯尼亚"], [/tanzania|坦桑尼亚/i, "坦桑尼亚"],
  [/uganda|乌干达/i, "乌干达"], [/ethiopia|埃塞俄比亚/i, "埃塞俄比亚"], [/zambia|赞比亚/i, "赞比亚"], [/zimbabwe|津巴布韦/i, "津巴布韦"],
  [/south africa|南非/i, "南非"], [/egypt|埃及/i, "埃及"], [/morocco|摩洛哥/i, "摩洛哥"], [/algeria|阿尔及利亚/i, "阿尔及利亚"],
  [/pakistan|巴基斯坦/i, "巴基斯坦"], [/india\b|印度(?!尼西亚)/i, "印度"], [/bangladesh|孟加拉/i, "孟加拉国"], [/sri lanka|斯里兰卡/i, "斯里兰卡"],
  [/indonesia|印度尼西亚|印尼/i, "印度尼西亚"], [/philippines|菲律宾/i, "菲律宾"], [/vietnam|越南/i, "越南"], [/thailand|泰国/i, "泰国"], [/malaysia|马来西亚/i, "马来西亚"],
  [/uzbekistan|乌兹别克/i, "乌兹别克斯坦"], [/kazakhstan|哈萨克/i, "哈萨克斯坦"], [/russia|俄罗斯/i, "俄罗斯"], [/turkey|türkiye|土耳其/i, "土耳其"],
  [/saudi|沙特/i, "沙特阿拉伯"], [/uae\b|emirates|阿联酋|迪拜|dubai/i, "阿联酋"], [/mexico|墨西哥/i, "墨西哥"], [/peru\b|秘鲁/i, "秘鲁"],
  [/colombia|哥伦比亚/i, "哥伦比亚"], [/brazil|巴西/i, "巴西"], [/argentina|阿根廷/i, "阿根廷"], [/ecuador|厄瓜多尔/i, "厄瓜多尔"],
  [/germany|德国/i, "德国"], [/france|法国/i, "法国"], [/spain|西班牙/i, "西班牙"], [/italy|意大利/i, "意大利"], [/poland|波兰/i, "波兰"], [/ukraine|乌克兰/i, "乌克兰"]
];

const LABELS = {
  company: /^(?:公司(?:名称|名)?|企业|单位|company(?:\s*name)?|firm|business|organization|organisation)\s*[:：=]\s*(.+)$/i,
  contact: /^(?:联系人|姓名|名字|客户|contact(?:\s*person)?|name|attn|attention|mr\.?|ms\.?)\s*[:：=]\s*(.+)$/i,
  phone: /^(?:电话|手机|联系电话|tel(?:ephone)?|phone|mobile|cell)\s*[:：=]\s*(.+)$/i,
  whatsapp: /^(?:whats\s*app|wa|ws)\s*[:：=]\s*(.+)$/i,
  wechat: /^(?:微信|wechat|we\s*chat|weixin)\s*[:：=]\s*(.+)$/i,
  country: /^(?:国家|country|地区|location|address)\s*[:：=]\s*(.+)$/i
};

const COMPANY_HINT = /\b(?:ltd|limited|llc|inc|corp|corporation|co\.|company|gmbh|s\.?a\.?|s\.?l\.?|pvt|plc|enterprises?|trading|farms?|feeds?|agro|agri|machinery|equipment|suppliers?|distribut\w+|dealers?)\b|公司|有限|贸易|饲料|农机|农业|养殖|经销|批发/i;

function clean(value: string) {
  return value.replace(/[​‎‏]/g, "").replace(/\s+/g, " ").trim();
}

function normalizePhone(raw: string) {
  const trimmed = raw.trim();
  const plus = trimmed.startsWith("+") || trimmed.startsWith("00");
  const digits = trimmed.replace(/\D/g, "").replace(/^00/, "");
  if (digits.length < 8 || digits.length > 15) return "";
  return plus ? `+${digits}` : digits;
}

function countryFromPhone(phone: string) {
  if (!phone.startsWith("+")) return "";
  const hit = DIAL_PREFIX
    .filter(([prefix]) => phone.startsWith(prefix))
    .sort((a, b) => b[0].length - a[0].length)[0];
  return hit ? hit[1] : "";
}

export function parseLeadText(input: string): ParsedLeadText {
  const text = String(input || "").slice(0, 20_000);
  const lines = text.split(/\r?\n/).map(clean).filter(Boolean);
  const result: ParsedLeadText = { company: "", contact: "", email: "", phone: "", whatsapp: "", wechat: "", country: "", website: "", confidence: 0, missing: [] };

  // 1) 带标签的行（公司：xxx / Tel: xxx）优先
  for (const line of lines) {
    let m: RegExpMatchArray | null;
    if (!result.company && (m = line.match(LABELS.company))) result.company = clean(m[1]);
    else if (!result.contact && (m = line.match(LABELS.contact))) result.contact = clean(m[1]);
    else if (!result.whatsapp && (m = line.match(LABELS.whatsapp))) result.whatsapp = normalizePhone(m[1]);
    else if (!result.phone && (m = line.match(LABELS.phone))) result.phone = normalizePhone(m[1]);
    else if (!result.wechat && (m = line.match(LABELS.wechat))) result.wechat = clean(m[1]).replace(/\s/g, "");
    else if (!result.country && (m = line.match(LABELS.country))) {
      const value = clean(m[1]);
      result.country = COUNTRY_WORDS.find(([re]) => re.test(value))?.[1] || "";
    }
  }

  // 2) 邮箱
  const emails = text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) || [];
  result.email = (emails.find((e) => !FREE_MAIL.has(e.split("@")[1].toLowerCase())) || emails[0] || "").toLowerCase();

  // 3) 网站（排除邮箱域名和社交平台）
  const urls = (text.match(/\b(?:https?:\/\/)?(?:www\.)?[a-z0-9][a-z0-9-]*(?:\.[a-z0-9-]+)*\.[a-z]{2,}(?:\/[^\s,;]*)?/gi) || [])
    .filter((u) => !u.includes("@") && !/(facebook|wa\.me|whatsapp|tiktok|instagram|linkedin|youtube)\./i.test(u) && !/@/.test(text.slice(Math.max(0, text.indexOf(u) - 1), text.indexOf(u))));
  const siteCandidate = urls.find((u) => !emails.some((e) => e.toLowerCase().endsWith(u.toLowerCase())));
  result.website = siteCandidate ? siteCandidate.replace(/[.)]+$/, "") : "";

  // 4) 手机号：wa.me 链接 > 含 + 的国际号码 > 其他长数字串
  const waLink = text.match(/wa\.me\/\+?(\d{8,15})/i);
  if (!result.whatsapp && waLink) result.whatsapp = `+${waLink[1]}`;
  const phoneMatches = (text.match(/(?:\+|00)\d[\d\s\-().]{7,18}\d/g) || []).map(normalizePhone).filter(Boolean);
  if (!result.phone) result.phone = phoneMatches.find((p) => p !== result.whatsapp) || "";
  if (!result.phone && !result.whatsapp) {
    // Only accept an unlabelled local number on a phone-only line. Numbers embedded in
    // company names, timestamps, registration IDs and invoice numbers are not contacts.
    const loose = lines
      .filter((line) => !COMPANY_HINT.test(line) && /^\+?[\d\s().-]{9,22}$/.test(line))
      .map(normalizePhone)
      .filter(Boolean);
    result.phone = loose[0] || "";
  }
  // 文中出现 WhatsApp 字样且只有一个号码：该号码同时作为 WhatsApp
  if (!result.whatsapp && /whats\s*app/i.test(text) && (result.phone || phoneMatches[0])) result.whatsapp = result.phone || phoneMatches[0];

  // 5) 国家：明确写出的国家名 > 手机区号
  if (!result.country) result.country = COUNTRY_WORDS.find(([re]) => re.test(text))?.[1] || "";
  if (!result.country) result.country = countryFromPhone(result.whatsapp) || countryFromPhone(result.phone);

  // 6) 公司：像公司名的行 > 非免费邮箱域名
  if (!result.company) {
    // 同一行用逗号/分号/竖线分隔的写法（“公司, 联系人, 电话, 邮箱”）也要能拆出公司名
    const segments = lines.flatMap((line) => line.split(/[,;|\t，；]/)).map(clean).filter(Boolean);
    const hinted = segments.find((line) => COMPANY_HINT.test(line) && line.length <= 80 && !/[@:：]/.test(line) && !/^\+?\d/.test(line));
    if (hinted) result.company = hinted;
  }
  if (!result.company && result.email) {
    const domain = result.email.split("@")[1];
    if (!FREE_MAIL.has(domain)) result.company = domain.split(".")[0].replace(/[-_]/g, " ");
  }

  // 7) 联系人：称呼行 / 第一行短文本（姓名）
  if (!result.contact) {
    const greeted = text.match(/(?:regards|sincerely|best|thanks|thank you|此致|敬礼)[,，:\s]*\n+\s*([A-Za-z][A-Za-z .'-]{1,40})/i);
    if (greeted) result.contact = clean(greeted[1]);
  }
  if (!result.contact) {
    const segs = lines.filter((line) => /[,;|，；]/.test(line)).flatMap((line) => line.split(/[,;|，；]/)).map(clean);
    const seg = segs.find((x) => x && x.length <= 40 && x !== result.company && !COMPANY_HINT.test(x) && !/[@:：\d/]/.test(x) && /^[A-Za-z\u4e00-\u9fa5][A-Za-z\u4e00-\u9fa5 .'-]+$/.test(x));
    if (seg && (result.company || result.email || result.phone || result.whatsapp)) result.contact = seg;
  }
  if (!result.contact && (result.company || result.email || result.phone || result.whatsapp || result.wechat)) {
    const nameLine = lines.find((line) => line.length <= 40 && !/[@:：\d/]/.test(line) && !COMPANY_HINT.test(line) && /^[A-Za-z一-龥][A-Za-z一-龥 .'-]+$/.test(line));
    if (nameLine) result.contact = nameLine;
  }

  // 置信度与缺失项
  const hasContactWay = Boolean(result.email || result.phone || result.whatsapp || result.wechat);
  result.confidence = Math.min(100,
    (result.company ? 35 : 0) + (hasContactWay ? 30 : 0) + (result.contact ? 10 : 0) + (result.country ? 15 : 0) + (result.email && (result.phone || result.whatsapp) ? 10 : 0));
  if (!result.company) result.missing.push("公司名称");
  if (!hasContactWay) result.missing.push("联系方式");
  if (!result.country) result.missing.push("国家");
  if (!result.contact) result.missing.push("联系人");
  return result;
}

/** 一次最多处理的客户数（防止误粘贴整个文件，也方便业务员逐条核对）。 */
export const MAX_BATCH_LEADS = 50;

const CONTACT_SIGNAL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}|(?:\+|00)\d[\d\s\-().]{7,18}\d|wa\.me\//i;

/**
 * 把包含多家客户的整段文字拆成一家一家。按优先级尝试：
 * 1) 编号（1. / 1、/ 1)） 2) 重复出现的“公司/Company:”标签 3) 空行分隔 4) 每行一家（每行都带邮箱或电话）。
 * 拆不开就当作一家。返回的每一段都保留原文，方便业务员核对。
 */
export function splitLeadBlocks(input: string): string[] {
  const text = String(input || "").replace(/\r\n?/g, "\n").trim();
  if (!text) return [];
  const lines = text.split("\n");

  // 1) 编号
  const numbered = /^\s*\d{1,3}\s*[.、)）]\s+\S/;
  if (lines.filter((line) => numbered.test(line)).length >= 2) {
    return groupByStart(lines, (line) => numbered.test(line)).map((b) => b.replace(/^\s*\d{1,3}\s*[.、)）]\s+/, ""));
  }
  // 2) 重复的公司标签
  const companyLabel = /^\s*(?:公司(?:名称|名)?|企业|company(?:\s*name)?)\s*[:：=]/i;
  if (lines.filter((line) => companyLabel.test(line)).length >= 2) {
    return groupByStart(lines, (line) => companyLabel.test(line));
  }
  // 3) 空行分隔
  const byBlank = text.split(/\n\s*\n+/).map((b) => b.trim()).filter((b) => b.length >= 5);
  if (byBlank.length >= 2) return byBlank;
  // 4) 每行一家
  const nonEmpty = lines.map((l) => l.trim()).filter(Boolean);
  if (nonEmpty.length >= 2 && nonEmpty.every((line) => CONTACT_SIGNAL.test(line))) return nonEmpty;
  return [text];
}

function groupByStart(lines: string[], isStart: (line: string) => boolean): string[] {
  const blocks: string[][] = [];
  for (const line of lines) {
    if (isStart(line) || blocks.length === 0) blocks.push([line]);
    else blocks[blocks.length - 1].push(line);
  }
  return blocks.map((b) => b.join("\n").trim()).filter((b) => b.length >= 5);
}

/** 批量识别：返回每一家的原文和识别结果（不含查重，查重需要数据库，由路由处理）。 */
export function parseLeadBatch(input: string): Array<{ index: number; raw: string; draft: ParsedLeadText }> {
  return splitLeadBlocks(input).map((raw, i) => ({ index: i + 1, raw, draft: parseLeadText(raw) }));
}
