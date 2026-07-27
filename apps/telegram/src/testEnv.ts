import * as dotenv from 'dotenv';
import { resolve } from 'path';
console.log('__dirname:', __dirname);
const path = resolve(__dirname, '../../../.env');
console.log('path:', path);
dotenv.config({ path });
console.log('ENCRYPTION_KEY:', process.env.ENCRYPTION_KEY);
