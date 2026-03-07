import express from 'express';
import cors from 'cors';
import TMNOne from './TMNOne.js';

const app = express();
// อนุญาตให้ Frontend เรียกใช้ API ได้
app.use(cors());
app.use(express.json());

const instance = new TMNOne();
let isConfigured = false; // ตัวแปรเช็คสถานะว่า Login หรือยัง

// --- 1. ระบบ Login (ตั้งค่า Instance) ---
app.post('/api/login', async (req, res) => {
    const config = req.body;
    
    try {
        console.log("🚀 กำลังตรวจสอบการเข้าสู่ระบบ...");
        
        // เซ็ตค่าลง Instance
        instance.setData(
            config.tmn_key_id, 
            config.mobile_number, 
            config.login_token, 
            config.tmn_id,
            config.device_id
        );

        // ทดสอบ Login ด้วย PIN
        const login = await instance.loginWithPin6(config.pin);

        if (login?.error || !login) {
            return res.status(401).json({ error: true, message: "ข้อมูลไม่ถูกต้อง หรือ Token หมดอายุ" });
        }

        // เก็บ PIN ไว้ใช้ตอนโอนเงิน
        instance.current_pin = config.pin; 
        isConfigured = true;

        console.log("✅ ระบบ Wallet พร้อมทำงาน!");
        res.json({ success: true, message: "เข้าสู่ระบบสำเร็จ" });
    } catch (error) {
        console.error("❌ Login Error:", error.message);
        res.status(500).json({ error: true, message: error.message });
    }
});

// --- Middleware ป้องกันคนนอกยิง API ---
const checkAuth = (req, res, next) => {
    if (!isConfigured) {
        return res.status(401).json({ error: true, message: "Unauthorized: กรุณา Login ก่อน" });
    }
    next();
};

// การตั้งค่า Face ID Webhook (สำหรับแจ้งเตือนสแกนหน้า)
instance.faceauth_webhook_url = "https://your-domain.com/api/face-notify";
instance.faceauth_wait_timeout = 180;

// --- 2. API Routes (ต้องผ่าน checkAuth ก่อนถึงจะทำได้) ---

app.get('/api/balance', checkAuth, async (req, res) => {
    try {
        const balance = await instance.getBalance();
        res.json(balance);
    } catch (error) {
        res.status(500).json({ error: true, message: error.message });
    }
});

app.get('/api/history', checkAuth, async (req, res) => {
    try {
        const { start, end } = req.query;
        const startDate = start || new Date().toISOString().split('T')[0];
        const endDate = end || startDate;

        const transactions = await instance.fetchTransactionHistory(startDate, endDate, 50, 1);
        res.json(transactions);
    } catch (error) {
        res.status(500).json({ error: true, message: error.message });
    }
});

app.post('/api/transfer/bank', checkAuth, async (req, res) => {
    const { bank_code, bank_ac, amount } = req.body;
    try {
        // ดึง PIN ที่เก็บไว้ตอน Login มาใช้
        const transfer = await instance.transferBankAC(
            bank_code, 
            bank_ac, 
            amount, 
            instance.current_pin 
        );

        if (transfer?.error) return res.status(400).json(transfer);
        res.json({ success: true, data: transfer });
    } catch (error) {
        res.status(500).json({ error: true, message: error.message });
    }
});

app.get('/api/recipient/:phone', checkAuth, async (req, res) => {
    try {
        const info = await instance.getRecipientInfo(req.params.phone);
        res.json(info);
    } catch (error) {
        res.status(500).json({ error: true, message: error.message });
    }
});

app.post('/api/transfer/p2p', checkAuth, async (req, res) => {
    const { phone, amount, message } = req.body;
    try {
        const transfer = await instance.transferP2P(phone, amount, message);
        if (transfer?.error) return res.status(400).json(transfer);
        res.json({ success: true, data: transfer });
    } catch (error) {
        res.status(500).json({ error: true, message: error.message });
    }
});

app.get('/api/payment-code', checkAuth, async (req, res) => {
    try {
        const code = await instance.getPaymentCode();
        res.json(code);
    } catch (error) {
        res.status(500).json({ error: true, message: error.message });
    }
});

// --- 3. Start Server ---
// รองรับ Port จาก Hosting (เช่น Render) หากไม่มีใช้ 3001
const PORT = process.env.PORT || 3001;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Server running on port ${PORT}`);
});