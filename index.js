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

// เชื่อม Google Sheets (ขยาย Range เป็น A1:Z1000 เพื่อให้คลุมคอลัมน์ที่เพิ่มใหม่ทั้งหมด)
async function getSheetData() {
  const credentials = JSON.parse(process.env.GOOGLE_CREDENTIALS_JSON);
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  });
  const sheets = google.sheets({ version: 'v4', auth });
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: CONFIG.SPREADSHEET_ID,
    range: 'Sheet1!A1:Z1000', // เริ่มจาก A1 เพื่อดึงหัวตารางมาเช็คตำแหน่งคอลัมน์
  });
  return res.data.values || [];
}

// ส่งข้อความเข้ากลุ่ม LINE (ปรับปรุงใหม่: ให้โชว์ยอดเงินปกติ ยอดค้าง และค่าปรับในสลิปข้อความด้วย)
async function sendBill(groupId, name, finalAmount, bank, originalAmount, delayCount, fineAmount) {
  const now = new Date();
  const timeStr = '18:00 น.';
  const dateStr = now.toLocaleDateString('th-TH', {
    year: 'numeric', month: 'long', day: 'numeric'
  });

  const bankInfo = CONFIG.BANK[bank] || CONFIG.BANK['K'];

  // สร้างข้อความแจ้งรายละเอียดเงินทบ + ค่าปรับ ให้ลูกค้าเห็นชัดเจน
  let billDetail = `💰 ยอดที่ต้องชำระ: ${Number(originalAmount).toLocaleString()} บาท\n`;
  if (Number(delayCount) > 0) {
    billDetail += `⚠️ ค้างชำระสะสม: ${delayCount} งวด\n`;
  }
  if (Number(fineAmount) > 0) {
    billDetail += `⚡ ค่าปรับล่าช้า: ${Number(fineAmount).toLocaleString()} บาท\n`;
  }

  const message = `📋 แจ้งยอดชำระสุทธิ
──────────────
👩🏻 คุณ ${name}
${billDetail}────────────────
💵 ยอดที่ต้องชำระ: ${Number(finalAmount).toLocaleString()} บาท
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

  console.log(`✅ ส่งบิลรวบยอดทบให้คุณ ${name} เรียบร้อยแล้ว (ยอดสุทธิ: ${finalAmount} บาท)`);
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

// 🔥 ฟังก์ชันหลักในการประมวลผลบิล (จับคู่หัวตารางอัตโนมัติ + คำนวณรวบยอด)
async function processBilling(checkConditions = true, dayOfWeekThai = '', dayOfMonth = 0) {
  const allRows = await getSheetData();
  if (allRows.length < 2) return; // ไม่มีข้อมูลลุกค้า

  // 1. ค้นหาตำแหน่งคอลัมน์จากแถวที่ 1 (หัวตาราง) อัตโนมัติ
  const headers = allRows[0].map(h => h.trim());
  const idxName = headers.indexOf('ชื่อลูกค้า'); // คอลัมน์ A (หรือตามที่ตั้งชื่อไว้)
  const idxAmount = headers.indexOf('ยอดเงิน') !== -1 ? headers.indexOf('ยอดเงิน') : 1; 
  const idxType = 2; // ประเภท
  const idxRound = 3; // รอบ
  const idxBank = 4; // บัญชี
  const idxGroupId = 5; // Group ID
  
  // คอลัมน์ใหม่ที่พี่เพิ่มเข้าไปใน Google Sheets
  const idxDelay = headers.indexOf('ค้างงวด'); 
  const idxFine = headers.indexOf('ค่าปรับ');

  // 2. เริ่มอ่านข้อมูลลูกค้าตั้งแต่แถวที่ 2 เป็นต้นไป
  const dataRows = allRows.slice(1);

  for (const row of dataRows) {
    const name = row[idxName] || '';
    const originalAmount = parseFloat(row[idxAmount] || 0);
    const type = row[idxType] || '';
    const round = row[idxRound] ? row[idxRound].trim() : '';
    const bank = row[idxBank] || 'K';
    const groupId = row[idxGroupId] || '';

    // อ่านค่าการค้างชำระและค่าปรับ (ถ้าไม่มีให้มองเป็น 0)
    const delayCount = idxDelay !== -1 && row[idxDelay] ? parseInt(row[idxDelay], 10) : 0;
    const fineAmount = idxFine !== -1 && row[idxFine] ? parseFloat(row[idxFine] || 0) : 0;

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
