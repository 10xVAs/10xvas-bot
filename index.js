// Run this ONCE with: node send_pin.js
// Then pin the message it sends in your Telegram topic

const axios = require('axios');

const TOKEN    = '8388439255:AAFqNnOaPoKJB2syNOpAWYjsciH9LDm61Tw';
const CHAT_ID  = '-1002490554910';
const TOPIC_ID = 27;
const MINI_APP_URL = 'YOUR_GHL_URL_HERE'; // ← replace this

async function sendPinnedButton() {
  try {
    const res = await axios.post(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
      chat_id:            CHAT_ID,
      message_thread_id:  TOPIC_ID,
      text:               '📲 Tap the button below to open the Time Tracker.',
      reply_markup: {
        inline_keyboard: [[
          { text: '🕐 Open Tracker', web_app: { url: MINI_APP_URL } }
        ]]
      }
    });
    console.log('✅ Message sent! Message ID:', res.data.result.message_id);
    console.log('Now go to Telegram and pin that message in the topic.');
  } catch(e) {
    console.error('❌ Error:', e.response?.data || e.message);
  }
}

sendPinnedButton();
