// 测试 parseTextInvoice 逻辑

const text = `合 计
价税合计(大写) (小写)
备
开票人:
注
发票号码:
开票日期:
销
售
方
信
息
购
买
方
信
息
名 称:
统一社会信用代码/纳税人识别号:
项目名称 
电子发票(普通发票)
名 称:大写) (小写)
统一社会信用代码/纳税人识别号:
北京京东世纪信息技术有限公司个人
91110302562134916R
*医疗仪器器械*创迈仕 古法悬灸筒 艾灸盒家用无烟随身灸艾灸   
罐全身通用艾条艾柱艾灸器具-5个【54粒艾柱+穴位图】
*医疗仪器器械*创迈仕 古法悬灸筒 艾灸盒家用无烟随身灸艾灸   
罐全身通用艾条艾柱艾灸器具-5个【54粒艾柱+穴位图】
*医疗仪器器械*创迈仕 艾灸盒随身灸家用小悬灸筒灸罐全身通用  
家用套装灸盒一体机全身用腹部腿部腰部热敷膝盖2个小灸筒+     
*医疗仪器器械*创迈仕 艾灸盒随身灸家用小悬灸筒灸罐全身通用  
家用套装灸盒一体机全身用腹部腿部腰部热敷膝盖2个小灸筒+     
C-1045 个 1 31.77 31.77 4.1313%
-6.35 -0.8213%
BJ085 个 1 17.61 17.61 2.2913%
-3.52 -0.4613%
¥39.51 ¥5.14
肆拾肆圆陆角伍分 ¥44.65:
订单号:298744710119 单 价 金 额 税率/征收率 税 额 
王梅
24117000000388542888
2024年07月24日`;

const normalizeValue = (value) => {
    if (!value) return undefined;
    const cleaned = value.replace(/\s+/g, " ").trim();
    if (!cleaned) return undefined;
    if (/^[：:，,.-]+$/.test(cleaned)) return undefined;
    return cleaned;
};

const normalizeInvoiceNumber = (value) => {
    const cleaned = normalizeValue(value);
    if (!cleaned) return undefined;
    const digits = cleaned.replace(/\D/g, "");
    if (digits.length < 8) return undefined;
    return digits;
};

const normalized = text.replace(/：/g, ':');
const lines = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);

console.log('=== 行结构 ===');
lines.forEach((line, i) => console.log(`[${i}] ${line}`));

console.log('\n=== 发票号码匹配 ===');
// 1. 标签匹配
const invoiceNumberMatch = normalized.match(/发票号码\s*[:：]?\s*([0-9]{8,20})/);
console.log('invoiceNumberMatch:', invoiceNumberMatch);

// 2. 独立20位数字行
const standalone20DigitLine = lines.find((line) => /^\d{20}$/.test(line.trim()));
console.log('standalone20DigitLine:', standalone20DigitLine);

// 3. 任意位置20位数字
const standalone20DigitMatch = normalized.match(/(?:^|[^\d])(\d{20})(?:$|[^\d])/);
console.log('standalone20DigitMatch:', standalone20DigitMatch);

console.log('\n=== 销售方名称匹配 ===');
// 查找统一社会信用代码下一行
const taxIdLabelIdx = lines.findIndex((line) =>
    /统一社会信用代码|纳税人识别号/.test(line) && line.includes(':')
);
console.log('taxIdLabelIdx:', taxIdLabelIdx);
if (taxIdLabelIdx >= 0 && taxIdLabelIdx < lines.length - 1) {
    const nextLine = lines[taxIdLabelIdx + 1];
    console.log('下一行:', nextLine);
    console.log('是否匹配公司名:', /公司|有限|集团|企业|商店|个人$/.test(nextLine));
}

console.log('\n=== "名 称:" 匹配 ===');
for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const match = line.match(/名\s*称[:：]\s*(.*)/);
    if (match) {
        console.log(`[${i}] 匹配: "${line}"`);
        console.log(`  内容: "${match[1].trim()}"`);
        console.log(`  无效内容检测: ${/大写|小写|^\(|^（|^-|^:/.test(match[1].trim())}`);
    }
}
