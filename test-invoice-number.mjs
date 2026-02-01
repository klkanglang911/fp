// 测试发票号码提取
import pdfjs from 'pdfjs-dist';
import fs from 'fs';

async function test() {
    const data = new Uint8Array(fs.readFileSync('./fixtures/digital_24117000000388542888.pdf'));
    const pdf = await pdfjs.getDocument({ data }).promise;
    const page = await pdf.getPage(1);
    const content = await page.getTextContent();

    let lastY;
    let lines = [];
    let line = '';

    content.items.forEach((item) => {
        if (!('str' in item)) return;
        const y = item.transform[5];
        if (lastY !== undefined && Math.abs(lastY - y) > 2) {
            if (line.trim()) lines.push(line.trim());
            line = '';
        }
        line += item.str;
        lastY = y;
    });
    if (line.trim()) lines.push(line.trim());

    console.log('=== 检查20位数字行 ===');
    lines.forEach((l, i) => {
        if (/^\d{20}$/.test(l.trim())) {
            console.log(`[${i}] 匹配: ${l}`);
        }
    });

    console.log('\n=== 末尾5行 ===');
    lines.slice(-5).forEach((l, i) => {
        console.log(`[${lines.length - 5 + i}] "${l}"`);
    });

    console.log('\n=== 发票号码相关行 ===');
    lines.forEach((l, i) => {
        if (l.includes('发票号码') || l.includes('24117') || /^\d{20}$/.test(l.trim())) {
            console.log(`[${i}] "${l}"`);
        }
    });
}

test().catch(console.error);
