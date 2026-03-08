import express from 'express';
import cors from 'cors';
import mongoose from 'mongoose'; // เปลี่ยนจากการใช้ fs เป็น mongoose
import TMNOne from './TMNOne.js';

const app = express();
// อนุญาตให้ Frontend เรียกใช้ API ได้
app.use(cors());
app.use(express.json());
app.use(cors({
  origin: ['https://truewallet-eight.vercel.app/', 'http://localhost:5173'], // ใส่ URL ของ Vercel คุณที่นี่
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true
}));

// --- เชื่อมต่อ MongoDB ---
const MONGO_URI = process.env.MONGO_URI || "mongodb+srv://nawinwin88_db_user:nawinwin46@cluster0.alvzybp.mongodb.net/wallet_db?retryWrites=true&w=majority";

mongoose.connect(MONGO_URI)
  .then(() => console.log('📦 เชื่อมต่อ MongoDB สำเร็จ!'))
  .catch(err => console.error('❌ เชื่อมต่อ MongoDB ไม่สำเร็จ:', err));

// สร้างโครงสร้าง (Schema) สำหรับเก็บข้อมูล Login
const sessionSchema = new mongoose.Schema({
    tmn_key_id: String,
    mobile_number: String,
    login_token: String,
    pin: String,
    tmn_id: String,
    device_id: String
});
const SessionDB = mongoose.model('Session', sessionSchema);

const instance = new TMNOne();
let isConfigured = false; // ตัวแปรเช็คสถานะว่า Login หรือยัง

// --- ฟังก์ชันกู้คืนเซสชัน (Auto Login เมื่อ Server เปิด) ---
const restoreSession = async () => {
    try {
        const config = await SessionDB.findOne(); // ดึงจาก Database แทนไฟล์
        
        if (config) {
            console.log("♻️ พบข้อมูลเซสชันใน Database กำลังกู้คืนการเข้าสู่ระบบ...");
            
            instance.setData(
                config.tmn_key_id, 
                config.mobile_number, 
                config.login_token, 
                config.tmn_id,
                config.device_id
            );

            const login = await instance.loginWithPin6(config.pin);
            if (login && !login.error) {
                instance.current_pin = config.pin;
                isConfigured = true;
                console.log("✅ กู้คืนเซสชันสำเร็จ! ระบบพร้อมใช้งานทันที");
            } else {
                console.log("⚠️ กู้คืนเซสชันไม่สำเร็จ: ข้อมูลอาจไม่ถูกต้อง หรือ Token หมดอายุแล้ว");
            }
        } else {
            console.log("ℹ️ ไม่พบข้อมูลเซสชันใน Database");
        }
    } catch (err) {
        console.error("⚠️ เกิดข้อผิดพลาดในการกู้คืนเซสชัน:", err.message);
    }
};

// เรียกใช้งานกู้คืนเซสชัน โดยหน่วงเวลา 2 วินาทีรอให้ Database เชื่อมต่อเสร็จ
setTimeout(restoreSession, 2000);

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

        // บันทึกข้อมูลการล็อกอินลง Database (อัปเดตทับข้อมูลเก่าหรือสร้างใหม่)
        await SessionDB.findOneAndUpdate({}, config, { upsert: true, new: true });

        console.log("✅ ระบบ Wallet พร้อมทำงาน และบันทึก Session ลง Database แล้ว!");
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