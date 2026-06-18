const express = require('express');
const { google } = require('googleapis');
const axios = require('axios');
const cron = require('node-cron');

const app = express();
app.use(express.json());

// ===== ดึงค่าจาก Environment Variables =====
const CONFIG = {
  LINE_TOKEN: process.env.LINE_TOKEN,
  SPREADSHEET_ID: process.env.SPREADSHEET_ID,
  BANK: {
    K: {
      name: 'ธนาคารกสิกรไทย',
      number: '0391696586',
      account: 'นัฎฐ์'
    },
    S: {
      name: 'ธนาคารไทยพาณิชย์',
      number: '4089878181',
      account: 'สิริประภา'
    }
  }
};
// ==========================

// เชื่อม Google Sheets (ดึงตั้งแต่แถวที่ 2 เป็นต้นไป ไม่ต้องสนหัวตารางเพื่อความปลอดภัย)
async function getSheetData() {
  const credentials = JSON.parse(process.env.GOOGLE_CREDENTIALS_JSON);
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  });
  const sheets = google.sheets({ version: 'v4', auth });
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: CONFIG.SPREADSHEET_ID,
    range: 'Sheet1!A2:H1000', // ดึงยาวไปถึงคอลัมน์ H เลยครับ
  });
  return res.data.values || [];
}

// ส่งข้อความเข้ากลุ่ม LINE
async function sendBill(groupId, name, finalAmount, bank, originalAmount, delayCount, fineAmount) {
  const now = new Date();
  const timeStr = '18:00 น.';
  const dateStr = now.toLocaleDateString('th-TH', {
    year: 'numeric', month: 'long', day: 'numeric'
  });

  const bankInfo = CONFIG.BANK[bank] || CONFIG.BANK['K'];

  // สร้างดีเทลแจ้งยอดทบ
  let billDetail = `💰 ยอดงวดนี้: ${Number(originalAmount).toLocaleString()} บาท\n`;
  if (Number(delayCount) > 0) {
    billDetail += `⚠️ ค้างชำระสะสม: ${delayCount} งวด\n`;
  }
  if (Number(fineAmount) > 0) {
    billDetail += `⚡ ค่าปรับล่าช้า: ${Number(fineAmount).toLocaleString()} บาท\n`;
  }

  const message = `📋 แจ้งยอดชำระสุทธิ
──────────────
👤 คุณ ${name}
${billDetail}────────────────
💵 รวมยอดที่ต้องโอน: ${Number(finalAmount).toLocaleString()} บาท
📅 ${dateStr} เวลา ${timeStr}
──────────────
โอนมาที่ ${bankInfo.name}
เลขที่บัญชี ${bankInfo.number}
ชื่อบัญชี ${bankInfo.account}`;

  await axios.post('https://api.line.me/v2/bot/message/push', {
    to: groupId,
    messages: [{ type: 'text', text: message }]
  }, {
    headers: {
      'Authorization': `Bearer ${CONFIG.LINE_TOKEN}`,
      'Content-Type': 'application/json'
    }
  });

  console.log(`✅ ส่งบิลรวบยอดให้คุณ ${name} แล้ว (ยอดสุทธิ: ${finalAmount} บาท)`);
}

// รับ Group ID อัตโนมัติเมื่อบอทถูก invite เข้ากลุ่ม
app.post('/webhook', async (req, res) => {
  res.sendStatus(200);
  const events = req.body.events || [];

  for (const event of events) {
    if (event.type === 'message' && event.source.type === 'group') {
      const groupId = event.source.groupId;
      const userId = event.source.userId;

      await axios.post('https://api.line.me/v2/bot/message/push', {
        to: userId,
        messages: [{
          type: 'text',
          text: `🔑 Group ID ของกลุ่มนี้คือ:\n${groupId}\n\nนำไปใส่ใน Google Sheets ได้เลยครับ`
        }]
      }, {
        headers: {
          'Authorization': `Bearer ${CONFIG.LINE_TOKEN}`,
          'Content-Type': 'application/json'
        }
      });
    }
  }
});

// ฟังก์ชันหลัก (ปรับกลับมาใช้ระบบนับช่องคอลัมน์ ล็อกตำแหน่งตามตารางของพี่ ป้องกันโค้ดเอ็กซิตพัง)
async function processBilling(checkConditions = true, dayOfWeekThai = '', dayOfMonth = 0) {
  const rows = await getSheetData();

  for (const row of rows) {
    // ล็อกตำแหน่งตามใจสั่ง: A=ชื่อ, B=ยอดเงิน, C=ประเภท, D=รอบ, E=บัญชี, F=GroupID, G=ค้างงวด, H=ค่าปรับ
    const name = row[0] || '';
    const originalAmount = parseFloat(row[1] || 0);
    const type = row[2] || '';
    const round = row[3] ? row[3].trim() : '';
    const bank = row[4] || 'K';
    const groupId = row[5] || '';
    
    // ค้างงวด (คอลัมน์ G คือ row[6]) และ ค่าปรับ (คอลัมน์ H คือ row[7])
    const delayCount = row[6] ? parseInt(row[6].trim(), 10) : 0;
    const fineAmount = row[7] ? parseFloat(row[7].trim()) : 0;

    if (!groupId || groupId === '(ว่าง)' || !name) continue;

    let shouldSend = false;

    // ตรวจสอบเงื่อนไขวัน (ระบบออโต้)
    if (checkConditions) {
      if (round === 'วัน' || round === 'รายวัน') {
        shouldSend = true;
      } 
      else if (round === dayOfWeekThai) {
        shouldSend = true; 
      } 
      else if (round !== '') {
        const datesArray = round.split(',').map(d => parseInt(d.trim(), 10));
        if (datesArray.includes(dayOfMonth)) {
          shouldSend = true;
        }
      }
    } else {
      // ถ้ารันมือแมนนวล ส่งทุกคนทันที
      shouldSend = true;
    }

    if (shouldSend) {
      // คำนวณรวบยอดออโต้
      const finalAmount = originalAmount + (originalAmount * (isNaN(delayCount) ? 0 : delayCount)) + (isNaN(fineAmount) ? 0 : fineAmount);

      await sendFlexBilling(groupId, row);
      await new Promise(r => setTimeout(r, 1000));
    }
  }
}

// ลิงก์หน้าแรกเพื่อเช็คสถานะ
app.get('/', (req, res) => {
  res.send('LINE Bot ระบบรวบยอดทบและค่าปรับอัจฉริยะ กำลังทำงานบน Render ✅');
});

// ลิงก์สำหรับกดส่งแมนนวลทันที
app.get('/test-billing', async (req, res) => {
  console.log('⚡ กำลังสั่งรันระบบทวงเงินแบบแมนนวลผ่านหน้าเว็บ...');
  try {
    await processBilling(false);
    res.send('✅ สั่งส่งบิลรวบยอดทบเข้ากลุ่ม LINE เรียบร้อยแล้วครับ!');
  } catch (err) {
    console.error('❌ เกิดข้อผิดพลาดตอนกดแมนนวล:', err.message);
    res.status(500).send(`❌ เกิดข้อผิดพลาดภายในระบบ: ${err.message}`);
  }
});

// 🔥 ระบบตั้งเวลาทำงานอัตโนมัติทุกวัน ตอนเวลา 09:00 น. (เวลาไทย)
cron.schedule('0 2 * * *', async () => {
  console.log('🕕 [Auto] บอทตื่นมาทำงานรอบอัตโนมัติเวลา 09:00 น. (เวลาไทย)');
  
  try {
    const now = new Date();
    const formatter = new Intl.DateTimeFormat('th-TH', {
      timeZone: 'Asia/Bangkok',
      weekday: 'long', 
      day: 'numeric',   
    });
    
    const parts = formatter.formatToParts(now);
    const dayOfWeekThai = parts.find(p => p.type === 'weekday').value; 
    const dayOfMonth = parseInt(parts.find(p => p.type === 'day').value, 10); 
    
    console.log(`📅 วันนี้คือ: ${dayOfWeekThai} | วันที่: ${dayOfMonth}`);

    await processBilling(true, dayOfWeekThai, dayOfMonth); 
    
    console.log('✅ ส่งบิลรอบประจำวันอัตโนมัติเสร็จสิ้น');
  } catch (err) {
    console.error('❌ เกิดข้อผิดพลาดในรอบอัตโนมัติ:', err.message);
  }
});

// บังคับจับพอร์ตจาก Render โดยตรง
const PORT = process.env.PORT || 10000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Bot รันที่พอร์ตระบบ ${PORT} เรียบร้อยสมบูรณ์`);
});

// --- [ส่วนที่เพิ่มใหม่] ฟังก์ชันส่งบิล Flex Message ---
async function sendFlexBilling(replyToken, row) {
  // ตั้งค่าข้อมูลตามคอลัมน์ใน Sheet 1 (A=0, B=1, E=4, H=7)
  const name = row[0];
  const amount = Number(row[1]) || 0;
  const fine = Number(row[7]) || 0;
  const total = amount + fine;
  
  // แปลงค่าบัญชีจากคอลัมน์ E (row[4])
  const bankMap = {
    'K': { name: 'ธนาคารกสิกรไทย', acc: '039-1-69658-6', owner: 'นัฎฐ์ เหล่าแสงทอง' },
    'S': { name: 'ธนาคารไทยพาณิชย์', acc: '408-9-87818-1', owner: 'สิริประภา สุดโสภา' }
  };
  const bank = bankMap[row[4]] || { name: 'โปรดตรวจสอบบัญชี', acc: '-', owner: '-' };

  const message = {
    type: "flex",
    altText: "แจ้งยอดชำระเงิน",
    contents: {
      type: "bubble",
      size: "giga",
      body: {
        type: "box",
        layout: "vertical",
        contents: [
          { type: "text", text: "แจ้งยอดชำระ", weight: "bold", color: "#1DB446", size: "sm" },
          { type: "text", text: "คุณ " + name, weight: "bold", size: "xxl", margin: "md" },
          { type: "separator", margin: "xxl" },
          {
            type: "box", layout: "vertical", margin: "xxl", spacing: "sm",
            contents: [
              { type: "box", layout: "horizontal", contents: [{ type: "text", text: "ยอดงวด:", size: "sm", color: "#555555" }, { type: "text", text: amount.toLocaleString() + " บาท", size: "sm", align: "end" }] },
              { type: "box", layout: "horizontal", contents: [{ type: "text", text: "ค่าปรับ:", size: "sm", color: "#555555" }, { type: "text", text: fine.toLocaleString() + " บาท", size: "sm", align: "end" }] },
              { type: "box", layout: "horizontal", margin: "xxl", contents: [{ type: "text", text: "รวมสุทธิ:", size: "sm", weight: "bold", color: "#555555" }, { type: "text", text: total.toLocaleString() + " บาท", size: "md", weight: "bold", color: "#FF0000", align: "end" }] },
              { type: "separator", margin: "xxl" },
              { type: "box", layout: "horizontal", contents: [{ type: "text", text: "โอนที่:", size: "sm", color: "#555555" }, { type: "text", text: bank.name, size: "sm", align: "end" }] },
              { type: "box", layout: "horizontal", contents: [{ type: "text", text: "เลขบัญชี:", size: "sm", color: "#555555" }, { type: "text", text: bank.acc, size: "sm", align: "end" }] }
            ]
          },
          { type: "separator", margin: "xxl" },
          { type: "box", layout: "vertical", margin: "md", contents: [{ type: "text", text: "โอนเสร็จแล้ว ส่งสลิปในกลุ่มนี้เลยครับ", size: "xs", color: "#aaaaaa", wrap: true }] }
        ]
      }
    }
  };
  await axios.post('https://api.line.me/v2/bot/message/push', {

    to: replyToken, // คือ groupId ของกลุ่มนั้น

    messages: [message]

  }, {

    headers: {

      'Authorization': `Bearer ${CONFIG.LINE_TOKEN}`,

      'Content-Type': 'application/json'

    }

  });
}
