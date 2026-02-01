// 测试脚本：提取 PDF 文本层内容
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import fs from 'fs';

const pdfPath = process.argv[2] || '../fixtures/digital_24117000000388542888.pdf';

async function extractText() {
    const data = fs.readFileSync(pdfPath);
    const pdf = await getDocument({ data }).promise;

    console.log(`=== PDF 文本层分析 ===`);
    console.log(`文件: ${pdfPath}`);
    console.log(`页数: ${pdf.numPages}`);
    console.log('');

    for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
        const page = await pdf.getPage(pageNum);
        const content = await page.getTextContent();

        console.log(`--- 第 ${pageNum} 页 ---`);

        // 按 Y 坐标分组，模拟行
        let lastY = undefined;
        let lineText = '';

        content.items.forEach((item, index) => {
            if (!('str' in item)) return;
            const y = item.transform[5];

            if (lastY !== undefined && Math.abs(lastY - y) > 2) {
                if (lineText.trim()) {
                    console.log(`[行] ${lineText.trim()}`);
                }
                lineText = '';
            }
            lineText += item.str;
            lastY = y;
        });

        // 输出最后一行
        if (lineText.trim()) {
            console.log(`[行] ${lineText.trim()}`);
        }
    }
}

extractText().catch(console.error);
