const {
  randomBytes
} = await import('node:crypto');
const {
  readFileSync,
  promises: fsp,
  writeFileSync,
  existsSync
} = await import('node:fs');
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const { createHmac } = await import('node:crypto');

import * as OTPAuth from 'otpauth';

import CONFIG from '../config.json' assert {type: "json"};

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const COUNTER_FILE = join(__dirname, '../database/hotpcounter');

let lastTOTP = '';

const OTP_SETTINGS = {
  issuer: 'Universalis',
  label: 'Hostie Assets TOTP',
  algorithm: 'SHA1',
  digits: 6,
  secret: CONFIG.secret
};

export const totp = new OTPAuth.TOTP({
  ...OTP_SETTINGS,
  period: 30
});
export const hotp = new OTPAuth.HOTP({
  ...OTP_SETTINGS,
  counter: existsSync(COUNTER_FILE) ? readFileSync(COUNTER_FILE) : 0
});

// An asset key is just a random 32 bytes saved to the database
export async function generateAssetKey() {
  return await randomBytes(32);
}

// Just an HMAC of the str provided using config.secret as the HMAC secret
export async function generateStatelessAssetKey(str) {
  const hash = createHmac('sha256', CONFIG.secret)
  .update(str)
  .digest('hex');

  return hash;
}

export async function validateToken(token, type = 'totp') {
  if (type === 'totp') {
    if (token === lastTOTP) throw new Error('Expired token');
    lastTOTP = token;
    let delta = totp.validate({
      token
    });
    if (delta === null) throw new Error('Invalid token');
    return delta;
  }

  else if (type === 'hotp') {
    let delta = hotp.validate({
      token
    });
    if (delta === null) throw new Error('Invalid token');
    await fsp.writeFile(COUNTER_FILE, hotp.counter.toString(), { flag: 'w+'});
    return delta;
  }
  throw new Error(`Unknown token type: ${type}`);
}
