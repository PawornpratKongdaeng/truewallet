import crypto from 'crypto';
import axios from 'axios';
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import zlib from 'zlib';
import { URL } from 'url';

class TMNOne {

    #tmnone_endpoint = 'https://api.tmn.one/api.php';
    #wallet_endpoint = 'https://api.tmn.one/proxy.dev.php/tmn-mobile-gateway/';
    #wallet_user_agent = 'tmnApp/truemoney tmnVersion/5.72.0 tmnBuild/1427 tmnPlatform/android';
    #wallet_version = '5.72.0';
    #tmnone_keyid = 0;
    #wallet_msisdn;
    #wallet_login_token;
    #wallet_tmn_id;
    #wallet_device_id;
    #wallet_access_token;
    #proxy_ip = '';
    #proxy_username = '';
    #proxy_password = '';
    #shield_id = '';
    #debugging = false;
    faceauth_webhook_url;
    faceauth_wait_timeout = 180;

    constructor() {}

    setData(tmnone_keyid, wallet_msisdn, wallet_login_token, wallet_tmn_id, wallet_device_id = '') {
        this.#tmnone_keyid = tmnone_keyid;
        this.#wallet_msisdn = wallet_msisdn;
        this.#wallet_login_token = wallet_login_token;
        this.#wallet_tmn_id = wallet_tmn_id;
        if (!wallet_device_id) {
            wallet_device_id = crypto.createHash('sha256').update(wallet_msisdn).digest('hex');
        }
        this.#wallet_device_id = wallet_device_id;
    }

    setProxy(proxy_ip, proxy_username, proxy_password) {
        this.#proxy_ip = proxy_ip;
        this.#proxy_username = proxy_username;
        this.#proxy_password = proxy_password;
    }

    setDataWithAccessToken(tmnone_keyid, wallet_access_token, wallet_login_token, wallet_device_id) {
        this.#tmnone_keyid = tmnone_keyid;
        this.#wallet_access_token = wallet_access_token;
        this.#wallet_login_token = wallet_login_token;
        this.#wallet_device_id = wallet_device_id;
    }

    enableDebugging() {
        this.#debugging = true;
    }

    async loginWithPin6(wallet_pin) {
        try {
            await this.#getCachedAccessToken();
            if (this.#wallet_access_token) {
                return this.#wallet_access_token;
            }
            if (!this.#shield_id) {
                this.#shield_id = await this.#getShieldID();
            }
            const uri = 'mobile-auth-service/v3/pin/login';
            const hashed_pin = crypto.createHash('sha256').update(this.#wallet_tmn_id + wallet_pin).digest('hex');
            const signature = await this.calculate_sign256(`/tmn-mobile-gateway/${uri}|${this.#wallet_login_token}|${this.#wallet_version}|${this.#wallet_device_id}|${hashed_pin}`);
            
            const postdata = {
                device_id: this.#wallet_device_id,
                pin: hashed_pin,
                app_version: this.#wallet_version
            };
            
            const headers = [
                'Content-Type: application/json',
                `Authorization: ${this.#wallet_login_token}`,
                `signature: ${signature}`,
                `X-Device: ${this.#wallet_device_id}`,
                'X-Geo-Location: city=; country=; country_code=',
                'X-Geo-Position: lat=; lng=',
                `X-Shield-Session-Id: ${this.#shield_id}`
            ];

            let wallet_response_body = await this.#wallet_connect(uri, headers, JSON.stringify(postdata));

            if (wallet_response_body.code && wallet_response_body.code.endsWith('-428') && wallet_response_body.data?.method === 'face') {
                const csid = wallet_response_body.data.csid;
                wallet_response_body = await this.#verifyFaceLogin(csid);
            }

            if (!wallet_response_body.code || !wallet_response_body.code.endsWith('-200')) {
                throw new Error(`${wallet_response_body.code} - ${wallet_response_body.message}`);
            }
            
            if (wallet_response_body.data?.access_token) {
                this.#wallet_access_token = wallet_response_body.data.access_token;
                const aes_key = crypto.createHash('sha512').update(this.#wallet_tmn_id).digest().slice(0, 32);
                const aes_iv = crypto.randomBytes(16);
                
                const cipher = crypto.createCipheriv('aes-256-cbc', aes_key, aes_iv);
                const encrypted_raw = Buffer.concat([
                    cipher.update(this.#wallet_access_token, 'utf8'),
                    cipher.final()
                ]);
                
                const encrypted_access_token = aes_iv.toString('hex') + encrypted_raw.toString('base64');
                const data = { access_token: encrypted_access_token, shield_id: this.#shield_id };
                const request_body = JSON.stringify({
                    scope: 'text_storage_obj',
                    cmd: 'set',
                    data: JSON.stringify(data)
                });
                
                await this.#tmnone_connect(request_body);
                await this.#uploadMetaData();
            }
        } catch (e) {
            console.log(`Error: ${e.message} on line ${e.stack.split('\n')[1]}`);
            return { error: e.message };
        }
        return this.#wallet_access_token;
    }

	/*
	ดึงข้อมูลค่าธรรมเนียม และจำนวนรายการที่เข้าเงื่อนไขถูกเก็บค่าธรรมเนียม
	channel = [ refill , p2p , promptpay-in , promptpay-out , datasender_api (สำหรับดึง URL จัดการ API/Webhook) ]
	*/
    async getWalletFee(channel) {
        const request_body = JSON.stringify({
            scope: 'extra',
            cmd: 'get_wallet_fees',
            data: {
                login_token: this.#wallet_login_token,
                device_id: this.#wallet_device_id,
                access_token: this.#wallet_access_token,
                fee_channel: channel
            }
        });
        const result = await this.#tmnone_connect(request_body);
        return result.result || null;
    }

	/*
	ดึง Amity Token (สำหรับใช้งาน Chat บน https://www.tmn.one/amity.html)
	*/
    async getAmityToken() {
        const uri = 'social-composite/v1/authentications/amity-token/';
        const signature = await this.calculate_sign256(`/tmn-mobile-gateway/${uri}|${this.#wallet_access_token}`);
        const headers = [
            'Content-Type: application/json',
            `Authorization: ${this.#wallet_access_token}`,
            `signature: ${signature}`,
            `X-Device: ${this.#wallet_device_id}`,
            'X-Geo-Location: city=; country=; country_code=',
            'X-Geo-Position: lat=; lng=',
            `X-Shield-Session-Id: ${this.#shield_id}`
        ];
        return await this.#wallet_connect(uri, headers, '-');
    }

	/*
	ดึงยอดเงินคงเหลือ
	*/
    async getBalance() {
        const uri = 'user-profile-composite/v1/users/balance/';
        const signature = await this.calculate_sign256(`/tmn-mobile-gateway/${uri}`);
        const headers = [
            'Content-Type: application/json',
            `Authorization: ${this.#wallet_access_token}`
        ];
        return await this.#wallet_connect(uri, headers, '');
    }

	/*
	ดึงรายการ Transaction
	start_date = วันที่เริ่มต้น (inclusive)
	end_date = วันที่สิ้นสุด (exclusive)
	limit = จำนวนรายการสูงสุดต่อหน้า (ไม่เกิน 50 รายการ)
	page = หน้า
	*/
    async fetchTransactionHistory(start_date, end_date, limit = 10, page = 1) {
        const uri = `history-composite/v1/users/transactions/history/?start_date=${start_date}&end_date=${end_date}&limit=${limit}&page=${page}&type=&action=`;
        const signature = await this.calculate_sign256(`/tmn-mobile-gateway/${uri}`);
        const headers = [
            'Content-Type: application/json',
            `Authorization: ${this.#wallet_access_token}`,
            `signature: ${signature}`,
            `X-Device: ${this.#wallet_device_id}`,
            'X-Geo-Location: city=; country=; country_code=',
            'X-Geo-Position: lat=; lng=',
            `X-Shield-Session-Id: ${this.#shield_id}`
        ];
        return await this.#wallet_connect(uri, headers, '');
    }

	/*
	ดึงรายละเอียด Transaction
	report_id = report_id ที่ได้มาจากขั้นตอน fetchTransactionHistory
	*/
    async fetchTransactionInfo(report_id) {
        const cache_filename = path.join(os.tmpdir(), `tmn-${report_id}`);
        const aes_key = crypto.createHash('sha512').update(this.#wallet_tmn_id).digest().slice(0, 32);

        try {
            const cached_data_buf = await fs.readFile(cache_filename);
            const iv_hex = cached_data_buf.slice(0, 32).toString('utf8');
            const aes_iv = Buffer.from(iv_hex, 'hex');
            const encrypted_part = cached_data_buf.slice(32);

            const decipher = crypto.createDecipheriv('aes-256-cbc', aes_key, aes_iv);
            const decrypted_raw = Buffer.concat([decipher.update(encrypted_part), decipher.final()]);
            
            let wallet_response_body = JSON.parse(decrypted_raw.toString('utf8'));
            wallet_response_body.cached = true;
            return wallet_response_body;

        } catch (e) {
            // Cache miss or read error
        }

        const uri = `history-composite/v1/users/transactions/history/detail/${report_id}?version=1`;
        const signature = await this.calculate_sign256(`/tmn-mobile-gateway/${uri}`);
        const headers = [
            'Content-Type: application/json',
            `Authorization: ${this.#wallet_access_token}`,
            `signature: ${signature}`,
            `X-Device: ${this.#wallet_device_id}`,
            'X-Geo-Location: city=; country=; country_code=',
            'X-Geo-Position: lat=; lng=',
            `X-Shield-Session-Id: ${this.#shield_id}`
        ];
        
        const wallet_response_body = await this.#wallet_connect(uri, headers, '');

        if (wallet_response_body.data) {
            try {
                const aes_iv = crypto.randomBytes(16);
                const cipher = crypto.createCipheriv('aes-256-cbc', aes_key, aes_iv);
                
                const data_to_encrypt = JSON.stringify(wallet_response_body.data);
                const encrypted_raw = Buffer.concat([
                    cipher.update(data_to_encrypt, 'utf8'),
                    cipher.final()
                ]);
                
                const iv_hex = aes_iv.toString('hex');
                const data_to_write = Buffer.concat([Buffer.from(iv_hex, 'utf8'), encrypted_raw]);
                
                await fs.writeFile(cache_filename, data_to_write);
            } catch (e) {
                console.warn(`Failed to write cache file ${cache_filename}: ${e.message}`);
            }
        }
        return wallet_response_body;
    }

	/*
	ตรวจสอบ QR Code บนสลิปโอนเงิน
	qr_data = ข้อมูล raw data ใน QR Code บนสลิป
	*/
    async fetchQRDetail(qr_data) {
        const uri = `history-composite/v1/users/transactions/history/qr-detail/${qr_data}`;
        const signature = await this.calculate_sign256(`/tmn-mobile-gateway/${uri}|${this.#wallet_access_token}`);
        const headers = [
            'Content-Type: application/json',
            `Authorization: ${this.#wallet_access_token}`,
            `signature: ${signature}`,
            `X-Device: ${this.#wallet_device_id}`,
            'X-Geo-Location: city=; country=; country_code=',
            'X-Geo-Position: lat=; lng=',
            `X-Shield-Session-Id: ${this.#shield_id}`
        ];
        return await this.#wallet_connect(uri, headers, '');
    }

	/*
	ดูประวัติการส่งซองอั่งเปา
	*/
    async fetchVoucherHistory() {
        const uri = 'transfer-composite/v1/vouchers/?limit=20&page=0';
        const signature = await this.calculate_sign256(`/tmn-mobile-gateway/${uri}|${this.#wallet_access_token}`);
        const headers = [
            'Content-Type: application/json',
            `Authorization: ${this.#wallet_access_token}`,
            `signature: ${signature}`,
            `X-Device: ${this.#wallet_device_id}`,
            'X-Geo-Location: city=; country=; country_code=',
            'X-Geo-Position: lat=; lng=',
            `X-Shield-Session-Id: ${this.#shield_id}`
        ];
        return await this.#wallet_connect(uri, headers, '');
    }

	/*
	สั่งซองอั่งเปา
	amount = จำนวนเงิน
	detail = รายละเอียดซอง
	*/
    async generateVoucher(amount, detail = '') {
        try {
            const uri = 'transfer-composite/v1/vouchers/';
            const signature = await this.calculate_sign256(`/tmn-mobile-gateway/${uri}|${this.#wallet_access_token}|F|${amount}|1|${detail}`);
            
            const post_body = JSON.stringify({
                amount: amount.toString(),
                detail: detail,
                duration: 24,
                isnotify: true,
                tmn_id: this.#wallet_tmn_id,
                mobile: this.#wallet_msisdn,
                voucher_type: "F",
                member: "1"
            });
            
            const headers = [
                'Content-Type: application/json',
                `Authorization: ${this.#wallet_access_token}`,
                `signature: ${signature}`,
                `X-Device: ${this.#wallet_device_id}`,
                'X-Geo-Location: city=; country=; country_code=',
                'X-Geo-Position: lat=; lng=',
                `X-Shield-Session-Id: ${this.#shield_id}`
            ];

            let wallet_response_body = await this.#wallet_connect(uri, headers, post_body);

            if (wallet_response_body.code && wallet_response_body.code.endsWith('-428') && wallet_response_body.data?.method === 'face') {
                const csid = wallet_response_body.data.csid;
                wallet_response_body = await this.#verifyFace(csid);
            }

            if (!wallet_response_body.code || !wallet_response_body.code.endsWith('-200')) {
                throw new Error(`${wallet_response_body.code} - ${wallet_response_body.message}`);
            }
            return wallet_response_body;
        } catch (e) {
            console.log(`Error: ${e.message} on line ${e.stack.split('\n')[1]}`);
            return { error: e.message };
        }
    }

	/*
	ดึงข้อมูลเบอร์ Wallet
	payee_wallet_id = เบอร์ Wallet ที่ต้องการตรวจสอบ
	*/
    async getRecipientInfo(payee_wallet_id) {
        const uri = `user-profile-composite/v1/users/public-profile/${payee_wallet_id}`;
        const signature = await this.calculate_sign256(`/tmn-mobile-gateway/${uri}`);
        const headers = [
            'Content-Type: application/json',
            `Authorization: ${this.#wallet_access_token}`,
            `signature: ${signature}`,
            `X-Device: ${this.#wallet_device_id}`,
            'X-Geo-Location: city=; country=; country_code=',
            'X-Geo-Position: lat=; lng=',
            `X-Shield-Session-Id: ${this.#shield_id}`
        ];
        return await this.#wallet_connect(uri, headers, '');
    }

	/*
	โอนเงิน P2P
	payee_wallet_id = เบอร์ Wallet ปลายทาง
	amount = จำนวนเงิน
	personal_msg = ข้อความ
	*/
    async transferP2P(payee_wallet_id, amount, personal_msg = '') {
        let draft_transaction_id = '';
        try {
            const amount_str = parseFloat(amount).toFixed(2);
            
            let uri = 'transfer-composite/v2/p2p-transfer/draft-transactions';
            let signature = await this.calculate_sign256(`/tmn-mobile-gateway/${uri}|${this.#wallet_access_token}|${amount_str}|${payee_wallet_id}`);
            
            let headers = [
                'Content-Type: application/json',
                `Authorization: ${this.#wallet_access_token}`,
                `signature: ${signature}`,
                `X-Device: ${this.#wallet_device_id}`,
                'X-Geo-Location: city=; country=; country_code=',
                'X-Geo-Position: lat=; lng=',
                `X-Shield-Session-Id: ${this.#shield_id}`
            ];
            
            let post_body = JSON.stringify({
                receiverId: payee_wallet_id,
                message: personal_msg,
                amount: amount_str
            });

            let wallet_response_body = await this.#wallet_connect(uri, headers, post_body);

            if (!wallet_response_body.code || !wallet_response_body.code.endsWith('-200')) {
                throw new Error(`${wallet_response_body.code} - ${wallet_response_body.message}`);
            }
            
            draft_transaction_id = wallet_response_body.data.draft_transaction_id;
            const reference_key = wallet_response_body.data.reference_key;

            uri = `transfer-composite/v2/p2p-transfer/transactions/${draft_transaction_id}`;
            signature = await this.calculate_sign256(`/tmn-mobile-gateway/${uri}|${this.#wallet_access_token}|${reference_key}`);
            
            headers = [
                'Content-Type: application/json',
                `Authorization: ${this.#wallet_access_token}`,
                `signature: ${signature}`,
                `X-Device: ${this.#wallet_device_id}`,
                'X-Geo-Location: city=; country=; country_code=',
                'X-Geo-Position: lat=; lng=',
                `X-Shield-Session-Id: ${this.#shield_id}`
            ];

            post_body = JSON.stringify({
                reference_key: reference_key
            });

            wallet_response_body = await this.#wallet_connect(uri, headers, post_body);

            if (wallet_response_body.code && wallet_response_body.code.endsWith('-428') && wallet_response_body.data?.method === 'face') {
                const csid = wallet_response_body.data.csid;
                wallet_response_body = await this.#verifyFace(csid);
            }

            if (!wallet_response_body.code || !wallet_response_body.code.endsWith('-200')) {
                throw new Error(`${wallet_response_body.code} - ${wallet_response_body.message}`);
            }

            wallet_response_body.draft_transaction_id = draft_transaction_id;
            return wallet_response_body;

        } catch (e) {
            console.log(`Error: ${e.message} on line ${e.stack.split('\n')[1]}`);
            return { error: e.message };
        }
    }

	/*
	ดึงสถานะการโอนเงิน P2P
	draft_transaction_id = draft_transaction_id จากขั้นตอน transferP2P
	*/
    async getTransferP2PStatus(draft_transaction_id) {
        const uri = `transfer-composite/v2/p2p-transfer/transactions/${draft_transaction_id}/status`;
        const signature = await this.calculate_sign256(`/tmn-mobile-gateway/${uri}|${this.#wallet_access_token}`);
        const headers = [
            'Content-Type: application/json',
            `Authorization: ${this.#wallet_access_token}`,
            `signature: ${signature}`,
            `X-Device: ${this.#wallet_device_id}`,
            'X-Geo-Location: city=; country=; country_code=',
            'X-Geo-Position: lat=; lng=',
            `X-Shield-Session-Id: ${this.#shield_id}`
        ];
        return await this.#wallet_connect(uri, headers, '');
    }

	/*
	โอนเงินพร้อมเพย์
	payee_proxy_value = หมายเลขพร้อมเพย์ (เบอร์โทร/บัตรประชาชน)
	amount = จำนวนเงิน
	*/
    async transferQRPromptpay(payee_proxy_value, amount) {
        try {
            const amount_str = parseFloat(amount).toFixed(2);
            
            let uri = 'transfer-composite/v1/promptpay/inquiries';
            let signature = await this.calculate_sign256(`/tmn-mobile-gateway/${uri}|${this.#wallet_access_token}|${amount_str}|${payee_proxy_value}|QR`);
            
            let headers = [
                'Content-Type: application/json',
                `Authorization: ${this.#wallet_access_token}`,
                `signature: ${signature}`,
                `X-Device: ${this.#wallet_device_id}`,
                'X-Geo-Location: city=; country=; country_code=',
                'X-Geo-Position: lat=; lng=',
                `X-Shield-Session-Id: ${this.#shield_id}`
            ];

            let post_body = JSON.stringify({
                amount: amount_str,
                input_method: "QR",
                to_proxy_value: payee_proxy_value
            });

            let wallet_response_body = await this.#wallet_connect(uri, headers, post_body);

            if (!wallet_response_body.code || !wallet_response_body.code.endsWith('-200')) {
                throw new Error(`${wallet_response_body.code} - ${wallet_response_body.message}`);
            }
            
            const draft_transaction_id = wallet_response_body.data.draft_transaction_id;

            uri = 'transfer-composite/v1/promptpay/transfers';
            signature = await this.calculate_sign256(`/tmn-mobile-gateway/${uri}|${this.#wallet_access_token}|${draft_transaction_id}`);
            
            headers = [
                'Content-Type: application/json',
                `Authorization: ${this.#wallet_access_token}`,
                `signature: ${signature}`,
                `X-Device: ${this.#wallet_device_id}`,
                'X-Geo-Location: city=; country=; country_code=',
                'X-Geo-Position: lat=; lng=',
                `X-Shield-Session-Id: ${this.#shield_id}`
            ];

            post_body = JSON.stringify({
                ref_number: draft_transaction_id
            });
            
            wallet_response_body = await this.#wallet_connect(uri, headers, post_body);

            if (wallet_response_body.code && wallet_response_body.code.endsWith('-428') && wallet_response_body.data?.method === 'face') {
                const csid = wallet_response_body.data.csid;
                wallet_response_body = await this.#verifyFace(csid);
            }

            if (!wallet_response_body.code || !wallet_response_body.code.endsWith('-200')) {
                throw new Error(`${wallet_response_body.code} - ${wallet_response_body.message}`);
            }
            
            return wallet_response_body;

        } catch (e) {
            console.log(`Error: ${e.message} on line ${e.stack.split('\n')[1]}`);
            return { error: e.message };
        }
    }

	/*
	โอนเงินเข้าบัญชีธนาคาร
	bank_code = SCB,BBL,BAY,KBANK,KTB,TTB,CIMB,LHBANK,UOB,KKP,GSB,BAAC,GHB,ISBT,TISCO,TCRB
	amount = จำนวนเงิน
	wallet_pin = PIN 6 หลักของ Wallet
	*/
    async transferBankAC(bank_code, bank_ac, amount, wallet_pin) {
        try {
            const amount_str = parseFloat(amount).toFixed(2);
            
            let signature = await this.calculate_sign256(`${amount_str}|${bank_code}|${bank_ac}`);
            let headers = [
                'Content-Type: application/json',
                `Authorization: ${this.#wallet_access_token}`,
                `signature: ${signature}`,
                `X-Device: ${this.#wallet_device_id}`,
                'X-Geo-Location: city=; country=; country_code=',
                'X-Geo-Position: lat=; lng=',
                `X-Shield-Session-Id: ${this.#shield_id}`
            ];
            
            let post_body = JSON.stringify({
                bank_name: bank_code,
                bank_account: bank_ac,
                amount: amount_str
            });

            let wallet_response_body = await this.#wallet_connect('fund-composite/v1/withdrawal/draft-transaction', headers, post_body);

            if (!wallet_response_body.code || !wallet_response_body.code.endsWith('-200')) {
                throw new Error(`${wallet_response_body.code} - ${wallet_response_body.message}`);
            }
            
            const draft_transaction_id = wallet_response_body.data.draft_transaction_id;

            const uri = 'fund-composite/v3/withdrawal/transaction';
            signature = await this.calculate_sign256(`/tmn-mobile-gateway/${uri}|${this.#wallet_access_token}|${draft_transaction_id}`);
            
            headers = [
                'Content-Type: application/json',
                `Authorization: ${this.#wallet_access_token}`,
                `signature: ${signature}`,
                `X-Device: ${this.#wallet_device_id}`,
                'X-Geo-Location: city=; country=; country_code=',
                'X-Geo-Position: lat=; lng=',
                `X-Shield-Session-Id: ${this.#shield_id}`
            ];
            
            post_body = JSON.stringify({
                draft_transaction_id: draft_transaction_id
            });

            wallet_response_body = await this.#wallet_connect(uri, headers, post_body);

            if (wallet_response_body.code && wallet_response_body.code.endsWith('-428') && wallet_response_body.data?.method === 'pin') {
                const csid = wallet_response_body.data.csid;
                const hashed_pin = crypto.createHash('sha256').update(this.#wallet_tmn_id + wallet_pin).digest('hex');
                
                signature = await this.calculate_sign256(`${this.#wallet_access_token}|${csid}|${hashed_pin}|manual_input`);
                
                headers = [
                    'Content-Type: application/json',
                    `Authorization: ${this.#wallet_access_token}`,
                    `signature: ${signature}`,
                    `X-Device: ${this.#wallet_device_id}`,
                    'X-Geo-Location: city=; country=; country_code=',
                    'X-Geo-Position: lat=; lng=',
                    `X-Shield-Session-Id: ${this.#shield_id}`,
                    `CSID: ${csid}`
                ];
                
                post_body = JSON.stringify({
                    pin: hashed_pin,
                    method: "manual_input"
                });

                wallet_response_body = await this.#wallet_connect('mobile-auth-service/v1/authentications/pin', headers, post_body);
            }

            if (wallet_response_body.code && wallet_response_body.code.endsWith('-428') && wallet_response_body.data?.method === 'face') {
                const csid = wallet_response_body.data.csid;
                wallet_response_body = await this.#verifyFace(csid);
            }

            if (!wallet_response_body.code || !wallet_response_body.code.endsWith('-200')) {
                throw new Error(`${wallet_response_body.code} - ${wallet_response_body.message}`);
            }

            return wallet_response_body;

        } catch (e) {
            console.log(`Error: ${e.message} on line ${e.stack.split('\n')[1]} (${e.lineNumber})`);
            return { error: `${e.message} (line:${e.lineNumber})` };
        }
    }

	/*
	สร้าง QR จ่ายเงิน (7-11 , ร้านค้าต่างๆ)
	ได้รับ data->payment_code เพื่อสร้าง QR Code สำหรับจ่ายเงิน
	*/
    async getPaymentCode() {
        const uri = 'payment-composite/v2/payment-codes/';
        const timestamp = Date.now();
        const signature = await this.calculate_sign256(`${this.#wallet_tmn_id}|BALANCE`);
        
        const headers = [
            'Content-Type: application/json',
            `Authorization: ${this.#wallet_access_token}`,
            `signature: ${signature}`,
            `X-Device: ${this.#wallet_device_id}`,
            'X-Geo-Location: city=; country=; country_code=',
            'X-Geo-Position: lat=; lng=',
            `X-Shield-Session-Id: ${this.#shield_id}`
        ];
        
        const post_body = JSON.stringify({
            asset_id: this.#wallet_tmn_id,
            asset_type: "BALANCE",
            signature: signature
        });
        
        return await this.#wallet_connect(uri, headers, post_body);
    }

    async #getCachedAccessToken() {
        const request_body = JSON.stringify({ scope: 'text_storage_obj', cmd: 'get' });
        const response = await this.#tmnone_connect(request_body);
        
        let data = {};
        try {
            if (response.data) {
                data = JSON.parse(response.data);
            }
        } catch (e) {
             // Ignore parsing error
        }

        const encrypted_access_token = data.access_token || '';
        this.#shield_id = data.shield_id || '';

        if (encrypted_access_token) {
            try {
                const aes_key = crypto.createHash('sha512').update(this.#wallet_tmn_id).digest().slice(0, 32);
                const aes_iv = Buffer.from(encrypted_access_token.substring(0, 32), 'hex');
                const encrypted_part = encrypted_access_token.substring(32);
                
                const decipher = crypto.createDecipheriv('aes-256-cbc', aes_key, aes_iv);
                const decrypted_raw = Buffer.concat([
                    decipher.update(Buffer.from(encrypted_part, 'base64')),
                    decipher.final()
                ]);
                
                const access_token = decrypted_raw.toString('utf8');
                if (access_token) {
                    this.#wallet_access_token = access_token;
                }
            } catch (e) {
                console.log(`Failed to decrypt cached token: ${e.message}`);
            }
        }
    }

    async #getShieldID() {
        const request_body = JSON.stringify({
            scope: 'extra',
            cmd: 'get_shield_id',
            data: { device_id: this.#wallet_device_id }
        });
        const response = await this.#tmnone_connect(request_body);
        return response.shield_id || '';
    }

    async #verifyFaceLogin(csid) {
        try {
            const uri = 'mobile-auth-service/v2/login-token-authentications/face';
            const signature = await this.calculate_sign256(`/tmn-mobile-gateway/${uri}|${this.#wallet_login_token}|${csid}`);
            
            const headers = [
                'Content-Type: application/json',
                `Authorization: ${this.#wallet_login_token}`,
                `signature: ${signature}`,
                `X-Device: ${this.#wallet_device_id}`,
                'X-Geo-Location: city=; country=; country_code=',
                'X-Geo-Position: lat=; lng=',
                `X-Shield-Session-Id: ${this.#shield_id}`,
                `CSID: ${csid}`,
                'os-version: 15',
                `tmn-app-version: ${this.#wallet_version}`,
                'verify-token: android',
                'channel: android'
            ];

            let wallet_response_body = await this.#wallet_connect(uri, headers, '-');

            if (!wallet_response_body.code || !wallet_response_body.code.endsWith('-200')) {
                throw new Error(`${wallet_response_body.code} - ${wallet_response_body.message}`);
            }

            const session_id = wallet_response_body.data.session_id;

            let request_body = JSON.stringify({
                scope: 'extra',
                cmd: 'face_verify_v2',
                data: { session_id: session_id }
            });
            await this.#tmnone_connect(request_body);

            if (this.faceauth_webhook_url) {
                this.#print_debugging('tmnone_connect', `faceauth_webhook_url = ${this.faceauth_webhook_url}`);
                try {
                    const webhook_response = await axios.post(this.faceauth_webhook_url, 
                        JSON.stringify({ wallet_msisdn: this.#wallet_msisdn }), 
                        { timeout: 10000, headers: { 'Content-Type': 'application/json' } }
                    );
                    this.#print_debugging('tmnone_connect', `faceauth_webhook_response = ${webhook_response.data}`);
                } catch (webhook_e) {
                    this.#print_debugging('tmnone_connect', `faceauth_webhook_response error: ${webhook_e.message}`);
                }
            }

            let face_verify_successful = false;
            this.#print_debugging('tmnone_connect', `faceauth_wait_timeout = ${this.faceauth_wait_timeout}`);
            
            for (let i = 0; i < this.faceauth_wait_timeout; i++) {
                const verification_result = await this.#tmnone_connect(request_body);
                if (verification_result.data?.status === 1) {
                    face_verify_successful = true;
                    break;
                }
                await new Promise(resolve => setTimeout(resolve, 2000));
            }

            if (!face_verify_successful) {
                throw new Error('Liveness Check Timeout');
            }

            const status_uri = `mobile-auth-service/v2/login-token-authentications/face/${session_id}/status`;
            const status_signature = await this.calculate_sign256(`/tmn-mobile-gateway/${status_uri}|${this.#wallet_login_token}|${csid}`);
            const status_headers = [
                'Content-Type: application/json',
                `Authorization: ${this.#wallet_login_token}`,
                `signature: ${status_signature}`,
                `X-Device: ${this.#wallet_device_id}`,
                'X-Geo-Location: city=; country=; country_code=',
                'X-Geo-Position: lat=; lng=',
                `X-Shield-Session-Id: ${this.#shield_id}`,
                `CSID: ${csid}`
            ];
            
            wallet_response_body = await this.#wallet_connect(status_uri, status_headers, '');
            return wallet_response_body;

        } catch (e) {
            console.log(`Error: ${e.message} on line ${e.stack.split('\n')[1]}`);
            return { error: e.message };
        }
    }

    async #verifyFace(csid) {
        try {
            const uri = 'mobile-auth-service/v2/authentications/face';
            const signature = await this.calculate_sign256(`/tmn-mobile-gateway/${uri}|${this.#wallet_access_token}|${csid}`);
            
            const headers = [
                'Content-Type: application/json',
                `Authorization: ${this.#wallet_access_token}`,
                `signature: ${signature}`,
                `X-Device: ${this.#wallet_device_id}`,
                'X-Geo-Location: city=; country=; country_code=',
                'X-Geo-Position: lat=; lng=',
                `X-Shield-Session-Id: ${this.#shield_id}`,
                `CSID: ${csid}`,
                'os-version: 15',
                `tmn-app-version: ${this.#wallet_version}`,
                'verify-token: android',
                'channel: android'
            ];

            let wallet_response_body = await this.#wallet_connect(uri, headers, '-');

            if (!wallet_response_body.code || !wallet_response_body.code.endsWith('-200')) {
                throw new Error(`${wallet_response_body.code} - ${wallet_response_body.message}`);
            }

            const session_id = wallet_response_body.data.session_id;

            let request_body = JSON.stringify({
                scope: 'extra',
                cmd: 'face_verify_v2',
                data: { session_id: session_id }
            });
            await this.#tmnone_connect(request_body);

            if (this.faceauth_webhook_url) {
                this.#print_debugging('tmnone_connect', `faceauth_webhook_url = ${this.faceauth_webhook_url}`);
                try {
                    const webhook_response = await axios.post(this.faceauth_webhook_url, 
                        JSON.stringify({ wallet_msisdn: this.#wallet_msisdn }), 
                        { timeout: 10000, headers: { 'Content-Type': 'application/json' } }
                    );
                    this.#print_debugging('tmnone_connect', `faceauth_webhook_response = ${webhook_response.data}`);
                } catch (webhook_e) {
                    this.#print_debugging('tmnone_connect', `faceauth_webhook_response error: ${webhook_e.message}`);
                }
            }

            let face_verify_successful = false;
            this.#print_debugging('tmnone_connect', `faceauth_wait_timeout = ${this.faceauth_wait_timeout}`);
            
            for (let i = 0; i < this.faceauth_wait_timeout; i++) {
                const verification_result = await this.#tmnone_connect(request_body);
                if (verification_result.data?.status === 1) {
                    face_verify_successful = true;
                    break;
                }
                await new Promise(resolve => setTimeout(resolve, 2000));
            }

            if (!face_verify_successful) {
                throw new Error('Liveness Check Timeout');
            }

            const status_uri = `mobile-auth-service/v2/authentications/face/${session_id}/status`;
            const status_signature = await this.calculate_sign256(`/tmn-mobile-gateway/${status_uri}|${this.#wallet_access_token}|${csid}`);
            const status_headers = [
                'Content-Type: application/json',
                `Authorization: ${this.#wallet_access_token}`,
                `signature: ${status_signature}`,
                `X-Device: ${this.#wallet_device_id}`,
                'X-Geo-Location: city=; country=; country_code=',
                'X-Geo-Position: lat=; lng=',
                `X-Shield-Session-Id: ${this.#shield_id}`,
                `CSID: ${csid}`
            ];
            
            wallet_response_body = await this.#wallet_connect(status_uri, status_headers, '');
            return wallet_response_body;

        } catch (e) {
            console.log(`Error: ${e.message} on line ${e.stack.split('\n')[1]}`);
            return { error: e.message };
        }
    }

    async #uploadMetaData() {
        const now = new Date();
        const pad = (num) => num.toString().padStart(2, '0');
        const date_time = `${pad(now.getDate())}/${pad(now.getMonth() + 1)}/${now.getFullYear()} ${pad(now.getHours())}:${pad(now.getMinutes())}`;

        const crc_val = zlib.crc32(this.#wallet_device_id);
        const disk_diff = crc_val % 1073741824;
		const diskspace_total = 118489088000 - disk_diff;
		const diskspace_used = 21474836480 + disk_diff;
		const diskspace_free = diskspace_total - diskspace_used;
		const app_first_installation = 1704067200000 + (crc_val % 31536000);

        const uri = 'device-composite/v1/users/device-metadata';
        const signature = await this.calculate_sign256(`/tmn-mobile-gateway/${uri}|${this.#wallet_access_token}|TrueMoney|100|${date_time}|11855978496|false|15`);
        
        const headers = [
            'Content-Type: application/json',
            `Authorization: ${this.#wallet_access_token}`,
            `signature: ${signature}`,
            `X-Device: ${this.#wallet_device_id}`,
            'X-Geo-Location: city=; country=; country_code=',
            'X-Geo-Position: lat=; lng=',
            `X-Shield-Session-Id: ${this.#shield_id}`
        ];

        const post_body = {
            app_first_installation: app_first_installation,
            app_name: "TrueMoney",
            app_package_name: "th.co.truemoney.wallet",
            app_version: this.#wallet_version,
            battery_level: 100,
            binding_devices_count: 0,
            build_product: "e2sxeea",
            cell_connected: false,
            connected_ssid: "<unknown ssid>",
            contact_count: 0,
            contact_list: [],
            cpu_num: 0,
            data_epoch_time: date_time,
            device_model: "SM-S926B",
            device_os: "android",
            device_type: "",
            diskspace_free: diskspace_free,
            diskspace_total: diskspace_total,
            diskspace_used: diskspace_used,
            gps_coord: { latitude: "", longitude: "" },
            installed_apps: [],
            installed_package_names: [],
            internet_type: "",
            mobile_dbm: "",
            network_type: "WIFI",
            os_version: "15",
            photo_count: 0,
            ramsize_total: 11855978496,
            resolution: { display: "1467", width: "720" },
            running_package_names: [],
            sim_carrier: "",
            sim_state: "SIM_STATE_ABSENT",
            sms_count: 0,
            timezone: "Asia/Bangkok",
            vpn_connected: false,
            wifi_connected: true
        };

        const wallet_response_body = await this.#wallet_connect(uri, headers, JSON.stringify(post_body));
        return wallet_response_body.code ? wallet_response_body : {};
    }

    #print_debugging(tag, message) {
        if (this.#debugging) {
            console.log(`${tag}\t${message}`);
        }
    }

    async #tmnone_connect(request_body_json) {
        this.#print_debugging('tmnone_connect', `request_body = ${request_body_json}`);
        let response_body;

        const aes_key = crypto.createHash('sha512').update(this.#wallet_login_token).digest().slice(0, 32);
        const aes_iv = crypto.randomBytes(16);

        try {
            const cipher = crypto.createCipheriv('aes-256-cbc', aes_key, aes_iv);
            const encrypted_raw = Buffer.concat([
                cipher.update(request_body_json, 'utf8'),
                cipher.final()
            ]);
            
            const encrypted_payload = aes_iv.toString('hex') + encrypted_raw.toString('base64');
            const postData = JSON.stringify({ encrypted: encrypted_payload });

            const headers = {
                'X-KeyID': this.#tmnone_keyid,
                'Content-Type': 'application/json',
                'User-Agent': `okhttp/4.4.0/202601302100/${this.#tmnone_keyid}`
            };

            const response = await axios.post(this.#tmnone_endpoint, postData, {
                headers: headers,
                timeout: 60000
            });

            if (response.headers['x-wallet-user-agent']) {
                this.#wallet_user_agent = response.headers['x-wallet-user-agent'];
            }
            if (response.headers['x-wallet-app-version']) {
                this.#wallet_version = response.headers['x-wallet-app-version'];
            }

            response_body = response.data;

            if (response_body && response_body.encrypted) {
                const decipher = crypto.createDecipheriv('aes-256-cbc', aes_key, aes_iv);
                const decrypted_raw = Buffer.concat([
                    decipher.update(Buffer.from(response_body.encrypted, 'base64')),
                    decipher.final()
                ]);
                response_body = JSON.parse(decrypted_raw.toString('utf8'));
            }

            this.#print_debugging('tmnone_connect', `response_body = ${JSON.stringify(response_body)}`);

        } catch (e) {
            console.log(`Error: ${e.message} on line ${e.stack.split('\n')[1]}`);
            return { error: e.message };
        }
        return response_body;
    }

    async #wallet_connect(uri, headers_array, request_body = '', custom_method = null) {
        this.#print_debugging('wallet_connect', `headers = ${JSON.stringify(headers_array)}`);
        this.#print_debugging('wallet_connect', `request_body = ${request_body}`);
        let response_body;

        try {
            const axios_headers = {};
            headers_array.forEach(header => {
                const parts = header.split(':');
                const key = parts.shift().trim();
                const value = parts.join(':').trim();
                if (key && value) {
                    axios_headers[key] = value;
                }
            });
            axios_headers['User-Agent'] = this.#wallet_user_agent;

            const config = {
                url: `${this.#wallet_endpoint}${uri}`,
                method: custom_method || (request_body ? 'POST' : 'GET'),
                headers: axios_headers,
                timeout: 60000,
                transformResponse: [(data) => data]
            };

            if (request_body) {
                config.data = request_body;
            }
            
            if (custom_method) {
                config.method = custom_method;
            }

            if (this.#proxy_ip) {
                const proxyUrl = new URL(this.#proxy_ip.startsWith('http') ? this.#proxy_ip : `http://${this.#proxy_ip}`);
                config.proxy = {
                    protocol: proxyUrl.protocol.replace(':', ''),
                    host: proxyUrl.hostname,
                    port: parseInt(proxyUrl.port, 10),
                };
                if (this.#proxy_username) {
                    config.proxy.auth = {
                        username: this.#proxy_username,
                        password: this.#proxy_password
                    };
                }
            }
            
            const response = await axios(config);
            
            try {
                response_body = JSON.parse(response.data);
            } catch (json_e) {
                response_body = response.data;
            }

            if (!response_body) {
                return '';
            }

            if (response_body.code === 'MAS-401') {
                const clear_cache_body = JSON.stringify({ scope: 'text_storage_obj', cmd: 'set', data: '' });
                await this.#tmnone_connect(clear_cache_body);
            }

        } catch (e) {
            if (e.response) {
                try {
                    response_body = JSON.parse(e.response.data);
                } catch (json_e) {
                    response_body = e.response.data;
                }
                
                if (response_body.code === 'MAS-401') {
                    const clear_cache_body = JSON.stringify({ scope: 'text_storage_obj', cmd: 'set', data: '' });
                    await this.#tmnone_connect(clear_cache_body);
                } else {
                    console.log(`Error: ${e.message} on line ${e.stack.split('\n')[1]}`);
                    return { error: e.message };
                }
            } else {
                console.log(`Error: ${e.message} on line ${e.stack.split('\n')[1]}`);
                return { error: e.message };
            }
        }

        this.#print_debugging('wallet_connect', `response_body = ${JSON.stringify(response_body)}`);
        return response_body;
    }

    async calculate_sign256(data) {
        const request_body = JSON.stringify({
            cmd: 'calculate_sign256',
            data: {
                login_token: this.#wallet_login_token,
                device_id: this.#wallet_device_id,
                data: data
            }
        });
        const response = await this.#tmnone_connect(request_body);
        return response.signature || '';
    }
}

export default TMNOne;