import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { 
  Wallet, History, Send, TrendingUp, CheckCircle2, 
  AlertCircle, RefreshCw, User, Building2, LogOut
} from 'lucide-react';

// รองรับการใช้ .env เมื่อขึ้น Production (ถ้าไม่มีจะใช้ localhost)
const API_BASE = import.meta.env.VITE_API_URL || "http://72.62.192.203:3001";

const BANKS = [
    { code: 'KBANK', name: 'กสิกรไทย' }, { code: 'SCB', name: 'ไทยพาณิชย์' },
    { code: 'BBL', name: 'กรุงเทพ' }, { code: 'KTB', name: 'กรุงไทย' },
    { code: 'BAY', name: 'กรุงศรีฯ' }, { code: 'TTB', name: 'ทีทีบี' },
    { code: 'GSB', name: 'ออมสิน' }, { code: 'UOB', name: 'ยูโอบี' },
    { code: 'KKP', name: 'เกียรตินาคิน' }, { code: 'BAAC', name: 'ธ.ก.ส.' },
    { code: 'GHB', name: 'อาคารสงเคราะห์' }, { code: 'CIMB', name: 'ซีไอเอ็มบี' }
];

const App = () => {
    // --- State สำหรับ Authentication (ปรับให้ดึงจาก localStorage) ---
    const [isLoggedIn, setIsLoggedIn] = useState(localStorage.getItem('isLoggedIn') === 'true');
    const [loginForm, setLoginForm] = useState({
        tmn_key_id: '', mobile_number: '', login_token: '', 
        pin: '', tmn_id: '', device_id: ''
    });

    // --- State สำหรับ Dashboard ---
    const [tab, setTab] = useState('summary'); 
    const [balance, setBalance] = useState('0.00');
    const [history, setHistory] = useState([]);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState(null);
    const [successMsg, setSuccessMsg] = useState(null);

    const [p2pForm, setP2pForm] = useState({ phone: '', amount: '', msg: '' });
    const [bankForm, setBankForm] = useState({ bank_code: 'KBANK', bank_ac: '', amount: '' });
    const [recipientName, setRecipientName] = useState('');
    const [isCheckingName, setIsCheckingName] = useState(false);
    const [currentPage, setCurrentPage] = useState(1);
    
    const itemsPerPage = 10;
    const indexOfLastItem = currentPage * itemsPerPage;
    const indexOfFirstItem = indexOfLastItem - itemsPerPage;
    const currentItems = history.slice(indexOfFirstItem, indexOfLastItem);
    const totalPages = Math.ceil(history.length / itemsPerPage);

    const totalIncome = useMemo(() => {
        return history.reduce((acc, tx) => {
            const amt = parseFloat(tx.amount.replace(/,/g, ''));
            return amt > 0 ? acc + amt : acc;
        }, 0);
    }, [history]);

    // ฟังก์ชันจัดการ Error (ถ้า Unauthorized ให้ Logout)
    const handleApiError = (err) => {
        if (err.message.includes('Unauthorized')) {
            setIsLoggedIn(false);
            localStorage.removeItem('isLoggedIn'); // ลบข้อมูลการจำสถานะออกด้วย
        }
        setError(err.message);
    };

    const handleLogin = async (e) => {
        e.preventDefault();
        setLoading(true);
        setError(null);
        try {
            const res = await fetch(`${API_BASE}/api/login`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(loginForm)
            }).then(r => r.json());

            if (res.error) throw new Error(res.message);
            
            setIsLoggedIn(true);
            localStorage.setItem('isLoggedIn', 'true'); // จำไว้ในเบราว์เซอร์
            
            setSuccessMsg("เข้าสู่ระบบสำเร็จ!");
            setTimeout(() => setSuccessMsg(null), 3000);
        } catch (err) {
            setError(err.message);
        } finally {
            setLoading(false);
        }
    };

    const fetchData = useCallback(async (isSilent = false) => {
        if (!isLoggedIn) return; // ถ้ายังไม่ล็อคอิน ไม่ต้องดึงข้อมูล
        if (!isSilent) setLoading(true);
        setError(null);
        try {
            const todayObj = new Date();
            const tomorrowObj = new Date();
            tomorrowObj.setDate(todayObj.getDate() + 1);

            const startDate = todayObj.toISOString().split('T')[0];
            const endDate = tomorrowObj.toISOString().split('T')[0];
            const cacheBuster = `&_t=${Date.now()}`;

            const bRes = await fetch(`${API_BASE}/api/balance?${cacheBuster}`).then(r => {
                if(r.status === 401) throw new Error("Unauthorized");
                return r.json();
            });
            if (bRes.error) throw new Error(bRes.message || "ดึงยอดเงินไม่สำเร็จ");
            setBalance(bRes.data?.current_balance || '0.00');

            const historyUrl = `${API_BASE}/api/history?start=${startDate}&end=${endDate}${cacheBuster}`;
            const hRes = await fetch(historyUrl).then(r => r.json());

            if (hRes.error) throw new Error(hRes.message || "ดึงประวัติไม่สำเร็จ");
            
            const rawActivities = hRes.data?.activities || [];
            setHistory(rawActivities); // แสดงทุกรายการโดยไม่ต้อง filter
        } catch (err) {
            handleApiError(err);
        } finally {
            if (!isSilent) setLoading(false);
        }
    }, [isLoggedIn]);

    // ดึงข้อมูลครั้งแรกเมื่อ Login สำเร็จ และตั้งเวลาดึงข้อมูลอัตโนมัติ
    useEffect(() => {
        if (isLoggedIn) {
            fetchData();
            const interval = setInterval(() => fetchData(true), 30000);
            return () => clearInterval(interval);
        }
    }, [isLoggedIn, fetchData]);

    // P2P Name Checking
    useEffect(() => {
        if (p2pForm.phone.length === 10 && isLoggedIn) {
            setIsCheckingName(true);
            fetch(`${API_BASE}/api/recipient/${p2pForm.phone}`)
                .then(r => {
                    if(r.status === 401) throw new Error("Unauthorized");
                    return r.json();
                })
                .then(res => { if (res.data?.name) setRecipientName(res.data.name); })
                .catch(err => handleApiError(err))
                .finally(() => setIsCheckingName(false));
        } else { setRecipientName(''); }
    }, [p2pForm.phone, isLoggedIn]);

    const handleP2P = async () => {
        if (!p2pForm.phone || !p2pForm.amount) return setError("กรุณากรอกข้อมูลให้ครบถ้วน");
        setLoading(true);
        try {
            const res = await fetch(`${API_BASE}/api/transfer/p2p`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(p2pForm)
            }).then(r => {
                if(r.status === 401) throw new Error("Unauthorized");
                return r.json();
            });
            if (res.error) throw new Error(res.message);
            setSuccessMsg(`โอนเงินสำเร็จ!`);
            setP2pForm({ phone: '', amount: '', msg: '' });
            fetchData();
        } catch (err) { handleApiError(err); }
        finally { setLoading(false); }
    };

    const handleBankTransfer = async () => {
        if (!bankForm.bank_ac || !bankForm.amount) return setError("กรุณากรอกเลขบัญชีและจำนวนเงิน");
        setLoading(true);
        try {
            const res = await fetch(`${API_BASE}/api/transfer/bank`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(bankForm)
            }).then(r => {
                if(r.status === 401) throw new Error("Unauthorized");
                return r.json();
            });
            
            if (res.error) throw new Error(res.message);
            setSuccessMsg(`ส่งคำสั่งโอนเงินเข้าธนาคารสำเร็จ!`);
            setBankForm({ ...bankForm, bank_ac: '', amount: '' });
            fetchData();
        } catch (err) { handleApiError(err); }
        finally { setLoading(false); }
    };

    // --- หน้า Login ---
    if (!isLoggedIn) {
        return (
            <div className="min-h-screen bg-slate-900 flex items-center justify-center p-4">
                <div className="bg-white w-full max-w-md rounded-[2.5rem] p-8 shadow-2xl animate-fadeIn">
                    <div className="text-center mb-8">
                        <div className="w-16 h-16 bg-orange-500 rounded-2xl flex items-center justify-center mx-auto mb-4 text-white shadow-lg">
                            <Wallet size={32} />
                        </div>
                        <h2 className="text-2xl font-black text-slate-800">ระบบจัดการ Wallet</h2>
                        <p className="text-slate-400 text-sm mt-1">กรุณากรอกข้อมูลเพื่อเชื่อมต่อ API</p>
                    </div>
                    <form onSubmit={handleLogin} className="space-y-3">
                        <input type="text" placeholder="TMN Key ID" className="w-full p-4 bg-slate-100 rounded-xl font-bold text-sm outline-none focus:bg-white border border-transparent focus:border-orange-500/50 transition-all" value={loginForm.tmn_key_id} onChange={e => setLoginForm({...loginForm, tmn_key_id: e.target.value})} required />
                        <input type="text" placeholder="Mobile Number" className="w-full p-4 bg-slate-100 rounded-xl font-bold text-sm outline-none focus:bg-white border border-transparent focus:border-orange-500/50 transition-all" value={loginForm.mobile_number} onChange={e => setLoginForm({...loginForm, mobile_number: e.target.value})} required />
                        <input type="text" placeholder="Login Token" className="w-full p-4 bg-slate-100 rounded-xl font-bold text-sm outline-none focus:bg-white border border-transparent focus:border-orange-500/50 transition-all" value={loginForm.login_token} onChange={e => setLoginForm({...loginForm, login_token: e.target.value})} required />
                        <input type="password" placeholder="PIN (6 หลัก)" className="w-full p-4 bg-slate-100 rounded-xl font-bold text-sm outline-none focus:bg-white border border-transparent focus:border-orange-500/50 transition-all" value={loginForm.pin} onChange={e => setLoginForm({...loginForm, pin: e.target.value})} required maxLength={6} />
                        <input type="text" placeholder="TMN ID" className="w-full p-4 bg-slate-100 rounded-xl font-bold text-sm outline-none focus:bg-white border border-transparent focus:border-orange-500/50 transition-all" value={loginForm.tmn_id} onChange={e => setLoginForm({...loginForm, tmn_id: e.target.value})} required />
                        <input type="text" placeholder="Device ID" className="w-full p-4 bg-slate-100 rounded-xl font-bold text-sm outline-none focus:bg-white border border-transparent focus:border-orange-500/50 transition-all" value={loginForm.device_id} onChange={e => setLoginForm({...loginForm, device_id: e.target.value})} required />
                        
                        <button disabled={loading} className="w-full bg-orange-500 text-white py-4 rounded-xl font-black text-lg mt-6 hover:bg-orange-600 transition-all shadow-lg shadow-orange-200 disabled:opacity-50">
                            {loading ? 'กำลังเชื่อมต่อ...' : 'เข้าสู่ระบบ'}
                        </button>
                    </form>
                    {error && <p className="text-red-500 text-xs mt-4 text-center font-bold bg-red-50 p-2 rounded-lg">{error}</p>}
                </div>
            </div>
        );
    }

    // --- หน้า Dashboard ---
    return (
        <div className="min-h-screen bg-slate-50 p-4 md:p-10 font-sans text-slate-900">
            <div className="max-w-5xl mx-auto">
                
                {/* Header */}
                <div className="flex justify-between items-center mb-6 px-2">
                    <span className="text-[11px] font-black text-slate-400 uppercase tracking-[0.2em] flex items-center">
                        <span className="w-2 h-2 bg-emerald-500 rounded-full mr-2 animate-pulse"></span>
                        Wallet Monitor
                    </span>
                    <div className="flex items-center space-x-4">
                        {loading && (
                            <div className="flex items-center text-orange-500 text-[10px] font-bold">
                                <RefreshCw size={12} className="mr-1 animate-spin" /> SYNCING
                            </div>
                        )}
                        {/* ปรับแก้ปุ่ม ออกจากระบบ ให้ลบ localStorage ด้วย */}
                        <button onClick={() => { setIsLoggedIn(false); localStorage.removeItem('isLoggedIn'); }} className="text-slate-400 hover:text-red-500 transition-colors flex items-center text-xs font-bold">
                            <LogOut size={14} className="mr-1" /> ออกจากระบบ
                        </button>
                    </div>
                </div>

                {/* Balance Card */}
                <div className="bg-gradient-to-br from-slate-900 to-slate-800 rounded-[2.5rem] p-10 text-white shadow-2xl mb-6 relative overflow-hidden">
                    <div className="relative z-10">
                        <div className="flex items-center opacity-80 mb-2">
                            <Wallet size={16} className="mr-2 text-orange-400" />
                            <p className="text-xs font-bold uppercase tracking-wider">ยอดเงินในบัญชี</p>
                        </div>
                        <div className="flex items-baseline space-x-3">
                            <span className="text-3xl font-light text-orange-400">฿</span>
                            <h1 className="text-7xl font-black tracking-tight italic">
                                {Number(balance).toLocaleString(undefined, { minimumFractionDigits: 2 })}
                            </h1>
                        </div>
                    </div>
                </div>

                {/* Income Summary Card */}
                <div className="grid grid-cols-1 mb-8">
                    <div className="bg-white p-6 rounded-[2.2rem] shadow-sm border border-slate-100 relative group overflow-hidden">
                        <div className="flex items-center text-slate-400 mb-2">
                            <TrendingUp size={14} className="mr-1.5 text-emerald-500" />
                            <p className="text-[10px] font-black uppercase tracking-tight">รวมเงินเข้าวันนี้</p>
                        </div>
                        <p className="text-3xl font-black text-emerald-500 italic">
                            +{totalIncome.toLocaleString(undefined, { minimumFractionDigits: 2 })}
                        </p>
                    </div>
                </div>

                {error && <div className="bg-red-50 text-red-700 p-4 rounded-2xl mb-6 text-sm flex items-center border border-red-100"><AlertCircle size={18} className="mr-2" /> {error} </div>}
                {successMsg && <div className="bg-emerald-50 text-emerald-700 p-4 rounded-2xl mb-6 text-sm flex items-center border border-emerald-100"><CheckCircle2 size={18} className="mr-2" /> {successMsg} </div>}

                {/* Navigation Tabs */}
                <div className="flex p-1.5 bg-slate-200 rounded-[2rem] mb-8 space-x-1 overflow-x-auto">
                    {[
                        { id: 'summary', label: 'เงินเข้า', icon: History },
                        { id: 'transfer', label: 'โอนวอลเล็ท', icon: Send },
                        { id: 'bank', label: 'โอนธนาคาร', icon: Building2 },
                    ].map((t) => (
                        <button 
                            key={t.id} 
                            onClick={() => {setTab(t.id); setSuccessMsg(null); setError(null);}} 
                            className={`flex-1 min-w-[100px] py-4 rounded-[1.6rem] font-bold transition-all flex items-center justify-center space-x-2 ${
                                tab === t.id ? 'bg-white text-orange-600 shadow-lg' : 'text-slate-500 hover:bg-slate-300/40'
                            }`}
                        >
                            <t.icon size={16} />
                            <span className="text-sm">{t.label}</span>
                        </button>
                    ))}
                </div>

                {/* Content View */}
                <div className="bg-white rounded-[3rem] shadow-xl p-8 min-h-[450px]">
                   {tab === 'summary' && (
                        <div className="animate-fadeIn">
                            <h2 className="text-2xl font-black text-slate-800 mb-8 flex items-center">
                                <History className="mr-3 text-blue-500" /> ประวัติรายการวันนี้
                            </h2>
                            <div className="space-y-4">
                                {currentItems.map((tx, i) => {
                                    const isExpense = tx.amount.startsWith('-'); 
                                    
                                    return (
                                        <div key={i} className="flex items-center justify-between p-5 bg-slate-50 rounded-[1.8rem] border border-slate-100">
                                            <div className="flex items-center space-x-4">
                                                <div className="w-12 h-12 bg-white rounded-2xl flex items-center justify-center shadow-sm p-1">
                                                    <img src={tx.logo_url} className="w-full h-full rounded-full object-contain" alt="" />
                                                </div>
                                                <div>
                                                    <p className="font-bold text-slate-800 leading-tight">{tx.title}</p>
                                                    <p className="text-[11px] text-slate-400 font-bold">{tx.date_time}</p>
                                                </div>
                                            </div>
                                            <div className="text-right">
                                                <p className={`text-xl font-black ${isExpense ? 'text-red-500' : 'text-emerald-500'}`}>
                                                    {!isExpense && tx.amount !== '0.00' ? '+' : ''}{tx.amount}
                                                </p>
                                                <p className="text-[10px] text-slate-300 font-black">THB</p>
                                            </div>
                                        </div>
                                    );
                                })}
                                
                                {history.length === 0 && (
                                    <div className="text-center py-20 text-slate-400 italic">ไม่มีรายการในวันนี้</div>
                                )}
                            </div>

                            {/* ปุ่มเปลี่ยนหน้า */}
                            {totalPages > 1 && (
                                <div className="flex justify-between items-center mt-8 pt-6 border-t border-slate-100">
                                    <button 
                                        onClick={() => setCurrentPage(prev => Math.max(prev - 1, 1))}
                                        disabled={currentPage === 1}
                                        className="px-5 py-3 text-sm font-black text-slate-600 bg-slate-100 rounded-xl disabled:opacity-40 hover:bg-slate-200 transition-all flex items-center"
                                    >
                                        &laquo; ก่อนหน้า
                                    </button>
                                    <span className="text-sm font-bold text-slate-400">
                                        หน้า {currentPage} / {totalPages}
                                    </span>
                                    <button 
                                        onClick={() => setCurrentPage(prev => Math.min(prev + 1, totalPages))}
                                        disabled={currentPage === totalPages}
                                        className="px-5 py-3 text-sm font-black text-slate-600 bg-slate-100 rounded-xl disabled:opacity-40 hover:bg-slate-200 transition-all flex items-center"
                                    >
                                        ถัดไป &raquo;
                                    </button>
                                </div>
                            )}
                        </div>
                    )}

                    {/* 2. โอนธนาคาร */}
                    {tab === 'bank' && (
                        <div className="max-w-md mx-auto py-6 animate-fadeIn">
                            <div className="text-center mb-10">
                                <div className="w-20 h-20 bg-blue-50 text-blue-600 rounded-3xl flex items-center justify-center mx-auto mb-4 shadow-inner">
                                    <Building2 size={32} />
                                </div>
                                <h3 className="font-black text-2xl text-slate-800">โอนเข้าบัญชีธนาคาร</h3>
                            </div>
                            <div className="space-y-5">
                                <select 
                                    className="w-full p-5 bg-slate-100 rounded-2xl font-bold outline-none border border-transparent focus:bg-white focus:ring-4 focus:ring-blue-500/10 transition-all"
                                    value={bankForm.bank_code}
                                    onChange={e => setBankForm({...bankForm, bank_code: e.target.value})}
                                >
                                    {BANKS.map(b => <option key={b.code} value={b.code}>{b.name}</option>)}
                                </select>
                                <input 
                                    type="text" 
                                    placeholder="เลขบัญชีธนาคาร" 
                                    className="w-full p-5 bg-slate-100 rounded-2xl font-bold text-lg outline-none focus:bg-white border border-transparent focus:border-blue-200 transition-colors"
                                    value={bankForm.bank_ac}
                                    onChange={e => setBankForm({...bankForm, bank_ac: e.target.value})}
                                />
                                <div className="relative">
                                    <div className="absolute left-5 top-5 text-blue-600 font-black text-xl">฿</div>
                                    <input 
                                        type="number" 
                                        placeholder="0.00" 
                                        className="w-full p-5 pl-14 bg-slate-100 rounded-2xl font-black text-3xl text-blue-600 outline-none focus:bg-white border border-transparent focus:border-blue-200 transition-colors"
                                        value={bankForm.amount}
                                        onChange={e => setBankForm({...bankForm, amount: e.target.value})}
                                    />
                                </div>
                                <button onClick={handleBankTransfer} disabled={loading} className="w-full bg-blue-600 text-white py-5 rounded-2xl font-black text-lg shadow-xl hover:bg-blue-700 transition-all active:scale-[0.98] disabled:opacity-50">
                                    {loading ? 'กำลังดำเนินการ...' : 'ยืนยันการโอน'}
                                </button>
                            </div>
                        </div>
                    )}

                    {/* 3. โอนวอลเล็ท (P2P) */}
                    {tab === 'transfer' && (
                        <div className="max-w-md mx-auto py-6 animate-fadeIn">
                            <div className="text-center mb-10">
                                <div className="w-20 h-20 bg-orange-100 text-orange-600 rounded-3xl flex items-center justify-center mx-auto mb-4 shadow-inner">
                                    <Send size={32} />
                                </div>
                                <h3 className="font-black text-2xl text-slate-800">โอนเงินวอลเล็ท</h3>
                            </div>
                            <div className="space-y-5">
                                <div className="relative">
                                    <div className="absolute left-5 top-5 text-slate-400"><User size={20} /></div>
                                    <input type="text" placeholder="เบอร์โทรศัพท์" className="w-full p-5 pl-14 bg-slate-100 rounded-2xl font-bold text-lg outline-none focus:bg-white border border-transparent focus:border-orange-200 transition-colors" value={p2pForm.phone} onChange={e => setP2pForm({...p2pForm, phone: e.target.value})} maxLength={10} />
                                    {isCheckingName && <div className="absolute right-4 top-5 animate-spin rounded-full h-6 w-6 border-b-2 border-orange-500"></div>}
                                    {recipientName && <div className="mt-3 ml-2 text-emerald-600 font-bold text-sm italic">✓ {recipientName}</div>}
                                </div>
                                <div className="relative">
                                    <div className="absolute left-5 top-5 text-orange-500 font-black text-xl">฿</div>
                                    <input type="number" placeholder="0.00" className="w-full p-5 pl-14 bg-slate-100 rounded-2xl font-black text-3xl text-orange-600 outline-none focus:bg-white border border-transparent focus:border-orange-200 transition-colors" value={p2pForm.amount} onChange={e => setP2pForm({...p2pForm, amount: e.target.value})} />
                                </div>
                                <button onClick={handleP2P} disabled={loading} className="w-full bg-slate-900 text-white py-5 rounded-2xl font-black text-lg shadow-xl hover:bg-black transition-all disabled:opacity-50">
                                    {loading ? 'กำลังดำเนินการ...' : 'ยืนยันโอนเงิน'}
                                </button>
                            </div>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
};

export default App;