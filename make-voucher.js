// Membuat kode voucher koin.  Contoh:  node make-voucher.js 5000 3   (3 kode senilai Rp5.000)
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const amount = parseInt(process.argv[2], 10);
const count = parseInt(process.argv[3] || '1', 10);
if (!amount || amount < 100 || !count || count < 1 || count > 500) {
  console.log('Cara pakai: node make-voucher.js <nilai_rupiah> [jumlah_kode]');
  console.log('Contoh    : node make-voucher.js 5000 3');
  process.exit(1);
}
const file = process.env.VOUCHER_FILE || path.join(__dirname, 'vouchers.json');
let v = {};
try { v = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
const made = [];
while (made.length < count) {
  const code = 'KOIN-' + crypto.randomBytes(3).toString('hex').toUpperCase() + '-' + crypto.randomBytes(3).toString('hex').toUpperCase();
  if (v[code]) continue;
  v[code] = { amount, used: false, created: Date.now() };
  made.push(code);
}
fs.writeFileSync(file, JSON.stringify(v, null, 2));
console.log(`Dibuat ${count} kode senilai Rp${amount.toLocaleString('id-ID')}:\n`);
made.forEach((c) => console.log('  ' + c));
