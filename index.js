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

// 🔥 ฟังก์ชันหลักที่ปรับปรุงใหม่: รองรับการเช็คเงื่อนไขตาม "วัน" และ "วันที่ระบุโดดๆ" แบบแม่นยำ
async function processBilling(checkConditions = true, dayOfWeekThai = '', dayOfMonth = 0) {
  const rows = await getSheetData();

  for (const row of rows) {
    const [name, amount, type, round, bank, groupId] = row;

    if (!groupId || groupId === '(ว่าง)') continue;

    let shouldSend = false;

    // ถ้าดึงระบบออโต้ (ให้เช็คเงื่อนไขตามวันและเวลาปัจจุบันของไทย)
    if (checkConditions) {
      const cycle = round ? round.trim() : '';

      if (cycle === 'วัน' || cycle === 'รายวัน') {
        shouldSend = true; // ส่งทุกวัน
      } 
      else if (cycle === 'อาทิตย์' || cycle === 'รายอาทิตย์') {
        if (dayOfWeekThai === 'วันจันทร์') shouldSend = true; // ส่งเฉพาะวันจันทร์
      } 
      else if (cycle === '15 วัน') {
        if (dayOfMonth === 1 || dayOfMonth === 16) shouldSend = true; // ส่งทุกวันที่ 1 และ 16 ของเดือน
      } 
      else if (cycle === '30 วัน' || cycle === 'เดือน' || cycle === 'รายเดือน') {
        if (dayOfMonth === 1) shouldSend = true; // ส่งเฉพาะวันที่ 1 ของเดือน
      } 
      else if (cycle === dayOfWeekThai) {
        shouldSend = true; // เจาะจงวันจันทร์ - วันอาทิตย์ ตรงเป๊ะกับวันนี้ค่อยส่ง
      } 
      else if (!isNaN(cycle) && cycle !== '') {
        // ถ้าพิมพ์เป็นเลขวันที่โดดๆ เช่น 21, 5, 10
        if (parseInt(cycle, 10) === dayOfMonth) {
          shouldSend = true; // ส่งเมื่อวันที่ปัจจุบันตรงกับตัวเลขในช่องรอบ
        }
      }
    } else {
      // ถ้าสั่งแบบแมนนวลผ่านลิงก์เว็บ (/test-billing) ให้ส่งหมดทุกคนเพื่อทดสอบ
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

// ลิงก์สำหรับกดเพื่อ "สั่งทวงเงินแมนนวลทันที" ผ่านหน้าเว็บ (ส่งทุกคนไม่สนเงื่อนไขวัน)
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

// 🔥 ตั้งเวลาทำงานอัตโนมัติทุกวัน ตอนเวลา 09:00 น. (เวลาไทย)
// เวลาไทย 09:00 น. ลบออก 7 ชั่วโมง จะตรงกับเวลาสากล 02:00 น. (0 2 * * *)
cron.schedule('0 2 * * *', async () => {
  console.log('🕕 [Auto] บอทตื่นมาทำงานรอบอัตโนมัติเวลา 09:00 น. (เวลาไทย)');
  
  try {
    // 1. ดึงวันที่และเวลาปัจจุบันแบบเวลาประเทศไทย (Asia/Bangkok)
    const now = new Date();
    const formatter = new Intl.DateTimeFormat('th-TH', {
      timeZone: 'Asia/Bangkok',
      weekday: 'long', // ได้ 'วันจันทร์', 'วันอังคาร', ..., 'วันพฤหัสบดี'
      day: 'numeric',   // ได้เลขวันที่ปัจจุบัน เช่น '5', '21', '25'
    });
    
    const parts = formatter.formatToParts(now);
    const dayOfWeekThai = parts.find(p => p.type === 'weekday').value; 
    const dayOfMonth = parseInt(parts.find(p => p.type === 'day').value, 10); 
    
    console.log(`📅 วันนี้คือ: ${dayOfWeekThai} | วันที่: ${dayOfMonth}`);

    // ส่งค่าชื่อวัน และเลขวันที่ เข้าไปในฟังก์ชันหลักเพื่อให้คำนวณแยกแยะได้อย่างถูกต้อง
    await processBilling(true, dayOfWeekThai, dayOfMonth); 
    
    console.log('✅ ส่งบิลรอบประจำวันอัตโนมัติเสร็จสิ้น');
  } catch (err) {
    console.error('❌ เกิดข้อผิดพลาดในรอบอัตโนมัติ:', err.message);
  }
});

// บังคับจับพอร์ตจาก Render โดยตรงเพื่อป้องกันอาการลิงก์ค้าง
const PORT = process.env.PORT || 10000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Bot รันที่พอร์ตระบบ ${PORT} เรียบร้อยสมบูรณ์`);
});
