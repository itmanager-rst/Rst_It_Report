import express from "express";
import path from "path";
import { createServer as createViteServer } from "vite";
import { GoogleGenAI, Type } from "@google/genai";

const app = express();
const PORT = 3000;

// Enable JSON body parsing with high limit for base64 files/images
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Lazy init Gemini client
function getGeminiClient() {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY environment variable is required");
  }
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      }
    }
  });
}

// 1. API: Analyze Single Quotation Document (PDF, Image / Mobile Camera, Text/Excel)
app.post("/api/gemini/analyze-quote", async (req, res) => {
  try {
    const { fileData, fileName, mimeType, projectItems } = req.body;
    const ai = getGeminiClient();

    let contents: any[] = [];
    
    let promptText = `
คุณเป็นผู้เชี่ยวชาญด้านการวิเคราะห์และตรวจสอบใบเสนอราคา (Quotation Inspection Expert) ของฝ่ายจัดซื้อบริษัท
โปรดอ่านและสกัดข้อมูลจากใบเสนอราคานี้ (รองรับทุกรูปแบบไฟล์: PDF, รูปถ่ายสแกน, ใบกำกับภาษี/ใบเสนอราคาแบบตารางทุกประเภท) ให้อยู่ในรูปแบบ JSON อย่างแม่นยำที่สุด:

1. ข้อมูลผู้ขาย: vendorName (ชื่อบริษัท/ร้านค้า), vendorCode (รหัสผู้ขาย), contactEmail, phone, rating (ประเมิน 1-5 ดาวจากความน่าเชื่อถือ)
2. เอกสาร: quoteNumber (เลขที่ใบเสนอราคา), quoteDate (วันที่ YYYY-MM-DD), validUntil (ยืนราคาถึงวันที่ YYYY-MM-DD)
3. เงื่อนไข: paymentTerms (เช่น 'เงินสด', 'โอนเงิน เครดิต 30 วัน'), deliveryDays (ระยะเวลาจัดส่งเป็นจำนวนวัน), warrantyMonths (ระยะเวลารับประกันกี่เดือน)
4. การเงิน: shippingFee (ค่าขนส่ง), vatIncluded (true หากราคารวม VAT 7% แล้ว), vatPercent (7), grandTotal (ราคารวมสุทธิทั้งสิ้น)
5. รายการสินค้าในตาราง (lineItems): สกัดทุกรายการในเอกสารอย่างแม่นยำ
   - จับคู่กับรายการในใบขอซื้อ (PR / projectItems) ตามความหมาย ชื่อสินค้า หรือสเปก:
     - itemId: ใส่ id ของรายการใน PR ที่ตรงกันที่สุด (ถ้ามี)
     - itemName: ชื่อรายการตามที่ปรากฏในใบเสนอราคา
     - offeredSpec: คุณลักษณะเฉพาะ/ขนาด/ความหนา/เกรด/ยี่ห้อ ตามใบเสนอราคา
     - unitPrice: ราคาต่อหน่วย (บาท)
     - qty: จำนวน
     - total: ราคารวมรายการ (บาท)
     - discountPercent: ส่วนลด (%)
     - hasSpecMismatch: boolean (กำหนดเป็น true หากสเปก ขนาด ความหนา เกรด หรือหน่วยนับที่เสนอ แตกต่างจาก PR)
     - specDiscrepancy: หากมีข้อแตกต่าง ให้ระบุรายละเอียดอย่างชัดเจนภาษาไทย เช่น "⚠️ สเปกบางกว่า PR: PR ขอหนา 12mm แต่เสนอ 11.8mm" หรือ "⚠️ เกรดต่างกัน: PR ขอ SUS 304 แต่เสนอ SUS 201" หรือ "⚠️ จำนวนไม่ตรง PR"
     - note: ข้อสังเกตเพิ่มเติม เช่น "มีสินค้าพร้อมส่ง" หรือ "ต้องสั่งทำ 7-10 วัน"

รายการอ้างอิงจากใบขอซื้อ (Purchase Requisition / projectItems):
${JSON.stringify(projectItems || [], null, 2)}
`;

    if (fileData && mimeType) {
      contents = [
        {
          inlineData: {
            mimeType: mimeType || 'image/jpeg',
            data: fileData // Base64
          }
        },
        { text: promptText }
      ];
    } else if (fileData && !mimeType) {
      contents = [
        { text: promptText + "\n\nเนื้อหาไฟล์หรือข้อความใบเสนอราคา:\n" + fileData }
      ];
    } else {
      return res.status(400).json({ error: "ไม่พบข้อมูลไฟล์หรือข้อความสำหรับวิเคราะห์" });
    }

    const response = await ai.models.generateContent({
      model: "gemini-3.6-flash",
      contents: { parts: contents },
      config: {
        thinkingConfig: { thinkingBudget: 0 },
        temperature: 0.1,
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            vendorName: { type: Type.STRING },
            vendorCode: { type: Type.STRING },
            quoteNumber: { type: Type.STRING },
            quoteDate: { type: Type.STRING },
            validUntil: { type: Type.STRING },
            contactEmail: { type: Type.STRING },
            phone: { type: Type.STRING },
            rating: { type: Type.NUMBER },
            deliveryDays: { type: Type.NUMBER },
            warrantyMonths: { type: Type.NUMBER },
            paymentTerms: { type: Type.STRING },
            shippingFee: { type: Type.NUMBER },
            vatIncluded: { type: Type.BOOLEAN },
            vatPercent: { type: Type.NUMBER },
            grandTotal: { type: Type.NUMBER },
            lineItems: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  itemId: { type: Type.STRING },
                  itemName: { type: Type.STRING },
                  offeredSpec: { type: Type.STRING },
                  unitPrice: { type: Type.NUMBER },
                  qty: { type: Type.NUMBER },
                  total: { type: Type.NUMBER },
                  discountPercent: { type: Type.NUMBER },
                  hasSpecMismatch: { type: Type.BOOLEAN },
                  specDiscrepancy: { type: Type.STRING },
                  note: { type: Type.STRING }
                },
                required: ["itemName", "unitPrice", "qty", "total"]
              }
            }
          },
          required: ["vendorName", "quoteNumber", "lineItems", "grandTotal"]
        }
      }
    });

    const parsedData = JSON.parse(response.text || '{}');
    res.json({ success: true, data: parsedData });
  } catch (error: any) {
    console.error("Gemini Analyze Quote Error:", error);
    res.status(500).json({ success: false, error: error.message || "เกิดข้อผิดพลาดในการวิเคราะห์ด้วย AI" });
  }
});

// 1b. API: Analyze Purchase Requisition (ใบขอซื้อ / PR Document)
app.post("/api/gemini/analyze-pr", async (req, res) => {
  try {
    const { fileData, fileName, mimeType } = req.body;
    const ai = getGeminiClient();

    let contents: any[] = [];

    let promptText = `
คุณเป็นระบบ AI ผู้เชี่ยวชาญด้านการอ่านและสกัดข้อมูลจากเอกสาร "ใบขอซื้อ" (Purchase Requisition / PR Document) ของฝ่ายจัดซื้อ
โปรดวิเคราะห์เอกสารใบขอซื้อนี้และสกัดข้อมูลสำคัญให้อยู่ในรูปแบบ JSON อย่างแม่นยำ:

1. projectTitle: ชื่อโครงการ หรือ ชื่องาน หรือ วัตถุประสงค์หลัก (เช่น "ชุดใบมีดดันดิน YM", "THIV-VN", "อุปกรณ์สำนักงาน")
2. prNumber: เลขที่ใบขอซื้อ หรือ เลขที่เอกสาร (เช่น "PR2608010005", "PR26070009")
3. category: หมวดหมู่สินค้าที่เหมาะสม (เช่น "เหล็กและโลหะโครงสร้าง", "ชิ้นส่วนเครื่องจักร / หุ่นยนต์", "อุปกรณ์สำนักงาน", "ทั่วไป")
4. companyName: ชื่อบริษัท/องค์กรผู้ขอซื้อ (ถ้ามี)
5. department: แผนก/ฝ่ายที่ขอซื้อ (ถ้ามี)
6. notes: วัตถุประสงค์ หรือ หมายเหตุ หรือ รายละเอียดเพิ่มเติมในเอกสาร
7. budget: ประเมินงบประมาณรวมตั้งไว้ (ถ้ามีในเอกสาร หรือเป็น 0 หากไม่มี)
8. items: รายการสินค้าทั้งหมดในตารางใบขอซื้อ สกัดให้ครบถ้วนทุกรายการ:
   - name: ชื่อสินค้า/รายละเอียดสินค้าภาษาไทย หรือ ภาษาอังกฤษ
   - code: รหัสสินค้า (ถ้ามี)
   - targetQty: จำนวนสั่งซื้อ (ตัวเลข)
   - unit: หน่วยนับ (เช่น เส้น, แผ่น, Pcs., เล่ม, ด้าม, ชุด, เครื่อง)
   - specs: คุณลักษณะเฉพาะ/ขนาด/ความหนา
   - benchmarkPrice: ประเมินราคากลางต่อหน่วย (ถ้าไม่ระบุในเอกสาร ให้ประเมินราคาตลาดโดยประมาณที่สมเหตุสมผล)
`;

    if (fileData && mimeType) {
      contents = [
        {
          inlineData: {
            mimeType: mimeType || 'image/jpeg',
            data: fileData // Base64
          }
        },
        { text: promptText }
      ];
    } else if (fileData && !mimeType) {
      contents = [
        { text: promptText + "\n\nเนื้อหาเอกสารใบขอซื้อ:\n" + fileData }
      ];
    } else {
      return res.status(400).json({ error: "ไม่พบข้อมูลไฟล์เอกสารใบขอซื้อ" });
    }

    const response = await ai.models.generateContent({
      model: "gemini-3.6-flash",
      contents: { parts: contents },
      config: {
        thinkingConfig: { thinkingBudget: 0 },
        temperature: 0.1,
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            projectTitle: { type: Type.STRING },
            prNumber: { type: Type.STRING },
            category: { type: Type.STRING },
            companyName: { type: Type.STRING },
            department: { type: Type.STRING },
            notes: { type: Type.STRING },
            budget: { type: Type.NUMBER },
            items: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  name: { type: Type.STRING },
                  code: { type: Type.STRING },
                  targetQty: { type: Type.NUMBER },
                  unit: { type: Type.STRING },
                  specs: { type: Type.STRING },
                  benchmarkPrice: { type: Type.NUMBER }
                },
                required: ["name", "targetQty", "unit"]
              }
            }
          },
          required: ["projectTitle", "prNumber", "items"]
        }
      }
    });

    const parsedData = JSON.parse(response.text || '{}');
    res.json({ success: true, data: parsedData });
  } catch (error: any) {
    console.error("Gemini Analyze PR Error:", error);
    res.status(500).json({ success: false, error: error.message || "เกิดข้อผิดพลาดในการวิเคราะห์ใบขอซื้อด้วย AI" });
  }
});

// 2. API: Synthesize Multi-Vendor Comparison & Recommendation
app.post("/api/gemini/analyze-comparison", async (req, res) => {
  try {
    const { project } = req.body;
    const ai = getGeminiClient();

    const promptText = `
คุณเป็นที่ปรึกษาการจัดซื้อเชิง стратеги (Strategic Procurement Advisor)
วิเคราะห์ตารางเปรียบเทียบใบเสนอราคาหลายเจ้านี้ สำหรับโครงการ: "${project.title}" (งบประมาณ ${project.budget || 'ไม่ระบุ'} บาท)

ข้อมูลโครงการและใบเสนอราคา:
${JSON.stringify(project, null, 2)}

ช่วยประเมินสรุป:
1. เจ้าที่เสนอราคาถูกที่สุด (Best Price Vendor)
2. เจ้าที่คุ้มค่าที่สุดโดยรวม (Best Value Vendor) โดยคำนึงถึง ราคา 60%, ระยะเวลาส่งมอบ 20%, การรับประกัน 10%, เครดิตเทอม/ความน่าเชื่อถือ 10%
3. เหตุผลประกอบการตัดสินใจ (reasoning) ภาษาไทย กระชับ ชัดเจน
4. จำนวนเงินที่ประหยัดได้เมื่อเทียบกับราคากลาง/คู่แข่ง (savingsEstimate)
5. ข้อสังเกตสำคัญ (keyInsights) เช่น "Vendor A เสนอราคาตลับหมึกถูกที่สุด แต่ระยะเวลาส่งนาน 7 วัน"
6. ข้อควรระวัง (warnings) เช่น "Vendor C ไม่รวม VAT", "ใบเสนอราคาหมดอายุวันที่..."
`;

    const response = await ai.models.generateContent({
      model: "gemini-3.6-flash",
      contents: promptText,
      config: {
        thinkingConfig: { thinkingBudget: 0 },
        temperature: 0.1,
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            recommendedVendorId: { type: Type.STRING },
            bestValueVendorId: { type: Type.STRING },
            reasoning: { type: Type.STRING },
            savingsEstimate: { type: Type.NUMBER },
            keyInsights: {
              type: Type.ARRAY,
              items: { type: Type.STRING }
            },
            warnings: {
              type: Type.ARRAY,
              items: { type: Type.STRING }
            }
          },
          required: ["recommendedVendorId", "bestValueVendorId", "reasoning", "keyInsights", "warnings"]
        }
      }
    });

    const result = JSON.parse(response.text || '{}');
    res.json({ success: true, analysis: result });
  } catch (error: any) {
    console.error("Gemini Comparison Error:", error);
    res.status(500).json({ success: false, error: error.message || "เกิดข้อผิดพลาดในการประมวลผลเปรียบเทียบ" });
  }
});

// 3. API: Simulate Live Store Feed Price Sync
app.get("/api/store-api/sync", (req, res) => {
  // Simulate small price fluctuations (e.g. ±1-3%)
  res.json({
    success: true,
    timestamp: new Date().toISOString().replace('T', ' ').substring(0, 19),
    message: "ซิงค์ข้อมูลราคาล่าสุดสำเร็จผ่าน Live Store API"
  });
});

async function startServer() {
  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`QuoteCompare server running on http://0.0.0.0:${PORT}`);
  });
}

startServer();
