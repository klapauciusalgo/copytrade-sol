import * as crypto from 'crypto';

const ALGORITHM = 'aes-256-cbc';
function getEncryptionKey(): string {
  const key = process.env.ENCRYPTION_KEY;
  if (!key) throw new Error("ENCRYPTION_KEY is not defined in environment");
  if (key.length !== 32) throw new Error("ENCRYPTION_KEY must be exactly 32 characters long");
  return key;
}

export interface EncryptedData {
  iv: string;
  encryptedData: string;
}

export function encrypt(text: string): EncryptedData {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(ALGORITHM, Buffer.from(getEncryptionKey()), iv);
  
  let encrypted = cipher.update(text);
  encrypted = Buffer.concat([encrypted, cipher.final()]);
  
  return {
    iv: iv.toString('hex'),
    encryptedData: encrypted.toString('hex')
  };
}

export function decrypt(encryptedData: string, iv: string): string {
  const ivBuffer = Buffer.from(iv, 'hex');
  const encryptedText = Buffer.from(encryptedData, 'hex');
  
  const decipher = crypto.createDecipheriv(ALGORITHM, Buffer.from(getEncryptionKey()), ivBuffer);
  
  let decrypted = decipher.update(encryptedText);
  decrypted = Buffer.concat([decrypted, decipher.final()]);
  
  return decrypted.toString();
}
