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
    // เมื่อมีคนส่งข้อความในกลุ่ม → แสดง Group ID
    if (event.type === 'message' && event.source.type === 'group') {
      const groupId = event.source.groupId;
      const userId = event.source.userId;

      // ส่ง Group ID กลับให้เจ้าของแบบ private message
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

// ส่งบิลทุกวัน 18:00 น. (เวลาไทย UTC+7)
// cron: นาที ชั่วโมง * * * 
// 18:00 ไทย = 11:00 UTC
cron.schedule('0 11 * * *', async () => {
  console.log('🕕 เริ่มส่งบิล 18:00 น...');
  try {
    const rows = await getSheetData();
    const today = new Date();
    const dayOfWeek = today.getDay(); // 0=อาทิตย์, 1=จันทร์ ...

    for (const row of rows) {
      const [name, amount, type, round, bank, groupId] = row;

      // ข้ามถ้าไม่มี Group ID ยังไม่ได้ตั้งค่า
      if (!groupId || groupId === '(ว่าง)') continue;

      let shouldSend = false;

      if (round === 'วัน') {
        // รายวัน → ส่งทุกวัน
        shouldSend = true;
      } else if (round === 'อาทิตย์') {
        // รายอาทิตย์ → ส่งทุกวันจันทร์
        shouldSend = (dayOfWeek === 1);
      } else if (round === 'เดือน') {
        // รายเดือน → ส่งวันที่ 1 ของเดือน
        shouldSend = (today.getDate() === 1);
      }

      if (shouldSend) {
        await sendBill(groupId, name, amount, bank);
        // หน่วงเวลา 1 วิ เพื่อไม่ให้ส่งเร็วเกินไป
        await new Promise(r => setTimeout(r, 1000));
      }
    }
    console.log('✅ ส่งบิลครบทุกกลุ่มแล้ว');
  } catch (err) {
    console.error('❌ เกิดข้อผิดพลาด:', err.message);
  }
});

app.get('/', (req, res) => res.send('LINE Bot กำลังทำงาน ✅'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Bot รันที่ port ${PORT}`));
