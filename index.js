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

// เชื่อม Google Sheets ผ่าน credentials จาก Environment Variable
async function getSheetData() {
  const credentials = JSON.parse(process.env.GOOGLE_CREDENTIALS_JSON);
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  });
  const sheets = google.sheets({ version: 'v4', auth });
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: CONFIG.SPREADSHEET_ID,
    range: 'Sheet1!A2:F1000',
  });
  return res.data.values || [];
}

// ส่งข้อความเข้ากลุ่ม LINE
async function sendBill(groupId, name, amount, bank) {
  const now = new Date();
  const timeStr = '18:00 น.';
  const dateStr = now.toLocaleDateString('th-TH', {
    year: 'numeric', month: 'long', day: 'numeric'
  });

  const bankInfo = CONFIG.BANK[bank] || CONFIG.BANK['K'];

  const message = `📋 แจ้งยอดชำระ
──────────────
👤 ${name}
💰 ยอดงวดนี้: ${Number(amount).toLocaleString()} บาท
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

  console.log(`✅ ส่งบิลให้ ${name} แล้ว`);
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

// ฟังก์ชันหลักที่ใช้วิ่งส่งข้อความ (แยกออกมาเพื่อแชร์ใช้ร่วมกันได้)
async function processBilling(checkConditions = true) {
  const rows = await getSheetData();
  const today = new Date();
  const dayOfWeek = today.getDay(); // 0=อาทิตย์, 1=จันทร์ ...

  for (const row of rows) {
    const [name, amount, type, round, bank, groupId] = row;

    if (!groupId || groupId === '(ว่าง)') continue;

    let shouldSend = false;

    // ถ้าไม่ได้สั่งแบบแมนนวล (ให้เช็คเงื่อนไขวันตามปกติ)
    if (checkConditions) {
      if (round && (round.includes('วัน'))) {
        shouldSend = true;
      } else if (round && (round.includes('อาทิตย์'))) {
        shouldSend = (dayOfWeek === 1); // ส่งวันจันทร์
      } else if (round && (round.includes('เดือน'))) {
        shouldSend = (today.getDate() === 1); // ส่งวันที่ 1
      }
    } else {
      // ถ้าสั่งแบบแมนนวลผ่านลิงก์เว็บ ให้ส่งหมดทุกคนที่มี Group ID ทันทีเพื่อทดสอบ
      shouldSend = true;
    }

    if (shouldSend) {
      await sendBill(groupId, name, amount, bank);
      await new Promise(r => setTimeout(r, 1000));
    }
  }
}

// ลิงก์หน้าแรกเพื่อเช็คสถานะ
app.get('/', (req, res) => {
  res.send('LINE Bot กำลังทำงานบน Render ได้อย่างสมบูรณ์แบบ ✅');
});

// ลิงก์สำหรับกดเพื่อ "สั่งทวงเงินแมนนวลทันที" ผ่านหน้าเว็บ
app.get('/test-billing', async (req, res) => {
  console.log('⚡ กำลังสั่งรันระบบทวงเงินแบบแมนนวลผ่านหน้าเว็บ...');
  try {
    await processBilling(false);
    res.send('✅ สั่งส่งบิลเข้ากลุ่ม LINE เรียบร้อยแล้ว! ลองเปิดดูใน LINE ได้เลยครับ');
  } catch (err) {
    console.error('❌ เกิดข้อผิดพลาดตอนกดแมนนวล:', err.message);
    res.status(500).send(`❌ เกิดข้อผิดพลาดภายในระบบ: ${err.message}`);
  }
});

// ส่งบิลทุกวันอัตโนมัติรอบ 18:00 น. (เวลาไทย UTC+7)
cron.schedule('0 11 * * *', async () => {
  console.log('🕕 เริ่มส่งบิลรอบอัตโนมัติประจำวัน 18:00 น...');
  try {
    await processBilling(true);
    console.log('✅ ส่งบิลรอบประจำวันครบถ้วน');
  } catch (err) {
    console.error('❌ เกิดข้อผิดพลาดในรอบอัตโนมัติ:', err.message);
  }
});

// บังคับจับพอร์ตจาก Render โดยตรงเพื่อป้องกันอาการลิงก์ค้าง
const PORT = process.env.PORT || 10000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Bot รันที่พอร์ตระบบ ${PORT} เรียบร้อยสมบูรณ์`);
});
